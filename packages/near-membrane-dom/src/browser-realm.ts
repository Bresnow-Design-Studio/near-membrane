import {
    assignFilteredGlobalDescriptorsFromPropertyDescriptorMap,
    CallableEvaluate,
    createBlueConnector,
    createRedConnector,
    getFilteredGlobalOwnKeys,
    linkIntrinsics,
    DistortionCallback,
    Getter,
    Instrumentation,
    PropertyKeys,
    SUPPORTS_SHADOW_REALM,
    VirtualEnvironment,
} from '@locker/near-membrane-base';

import {
    getCachedGlobalObjectReferences,
    filterWindowKeys,
    removeWindowDescriptors,
    unforgeablePoisonedWindowKeys,
} from './window';

export interface BrowserEnvironmentOptions {
    distortionCallback?: DistortionCallback;
    endowments?: PropertyDescriptorMap;
    globalObjectShape?: object;
    keepAlive?: boolean;
    instrumentation?: Instrumentation;
}

const IFRAME_SANDBOX_ATTRIBUTE_VALUE = 'allow-same-origin allow-scripts';

const ObjectCtor = Object;
const TypeErrorCtor = TypeError;
const { prototype: DocumentProto } = Document;
const { bind: FunctionProtoBind } = Function.prototype;
const { prototype: NodeProto } = Node;
const { remove: ElementProtoRemove, setAttribute: ElementProtoSetAttribute } = Element.prototype;
const { appendChild: NodeProtoAppendChild } = NodeProto;
const {
    assign: ObjectAssign,
    create: ObjectCreate,
    getOwnPropertyDescriptors: ObjectGetOwnPropertyDescriptors,
} = ObjectCtor;
// eslint-disable-next-line @typescript-eslint/naming-convention
const { __lookupGetter__: ObjectProtoLookupGetter } = ObjectCtor.prototype as any;
const { apply: ReflectApply } = Reflect;
const {
    close: DocumentProtoClose,
    createElement: DocumentProtoCreateElement,
    open: DocumentProtoOpen,
} = DocumentProto;
const DocumentProtoBodyGetter: Getter = ReflectApply(ObjectProtoLookupGetter, DocumentProto, [
    'body',
])!;
const HTMLElementProtoStyleGetter: Getter = ReflectApply(
    ObjectProtoLookupGetter,
    HTMLElement.prototype,
    ['style']
)!;
const HTMLIFrameElementProtoContentWindowGetter: Getter = ReflectApply(
    ObjectProtoLookupGetter,
    HTMLIFrameElement.prototype,
    ['contentWindow']
)!;
const NodeProtoLastChildGetter: Getter = ReflectApply(ObjectProtoLookupGetter, NodeProto, [
    'lastChild',
])!;
// @ts-ignore: Prevent cannot find name 'ShadowRealm' error.
const ShadowRealmCtor = SUPPORTS_SHADOW_REALM ? ShadowRealm : undefined;
const ShadowRealmProtoEvaluate: CallableEvaluate | undefined = ShadowRealmCtor?.prototype?.evaluate;
const defaultGlobalOwnKeysRegistry = { __proto__: null };
const docRef = document;

let defaultGlobalOwnKeys: PropertyKeys | null = null;
let defaultGlobalPropertyDescriptorMap: PropertyDescriptorMap | null = null;

function createDetachableIframe(): HTMLIFrameElement {
    const iframe = ReflectApply(DocumentProtoCreateElement, docRef, [
        'iframe',
    ]) as HTMLIFrameElement;
    // It is impossible to test whether the NodeProtoLastChildGetter branch is
    // reached in a normal Karma test environment.
    const parent: Element =
        ReflectApply(DocumentProtoBodyGetter, docRef, []) ??
        /* istanbul ignore next */ ReflectApply(NodeProtoLastChildGetter, docRef, []);
    const style: CSSStyleDeclaration = ReflectApply(HTMLElementProtoStyleGetter, iframe, []);
    style.display = 'none';
    ReflectApply(ElementProtoSetAttribute, iframe, ['sandbox', IFRAME_SANDBOX_ATTRIBUTE_VALUE]);
    ReflectApply(NodeProtoAppendChild, parent, [iframe]);
    return iframe;
}

function createIframeVirtualEnvironment(
    globalObject: WindowProxy & typeof globalThis,
    options?: BrowserEnvironmentOptions
): VirtualEnvironment {
    if (typeof globalObject !== 'object' || globalObject === null) {
        throw new TypeErrorCtor('Missing global object virtualization target.');
    }
    const {
        distortionCallback,
        endowments,
        globalObjectShape,
        instrumentation,
        keepAlive = false,
        // eslint-disable-next-line prefer-object-spread
    } = ObjectAssign({ __proto__: null }, options);
    const iframe = createDetachableIframe();
    const redWindow: Window & typeof globalThis = ReflectApply(
        HTMLIFrameElementProtoContentWindowGetter,
        iframe,
        []
    )!;
    const shouldUseDefaultGlobalOwnKeys =
        typeof globalObjectShape !== 'object' || globalObjectShape === null;
    if (shouldUseDefaultGlobalOwnKeys && defaultGlobalOwnKeys === null) {
        defaultGlobalOwnKeys = filterWindowKeys(getFilteredGlobalOwnKeys(redWindow));
    }
    const blueRefs = getCachedGlobalObjectReferences(globalObject);
    const env = new VirtualEnvironment({
        blueConnector: createBlueConnector(globalObject),
        distortionCallback,
        instrumentation,
        redConnector: createRedConnector(redWindow.eval),
    });
    linkIntrinsics(env, globalObject);
    // window
    // window.document
    // In browsers globalThis is === window.
    if (typeof globalThis === 'undefined') {
        // Support for globalThis was added in Chrome 71.
        // However, environments like Android emulators are running Chrome 69.
        env.link('window', 'document');
    } else {
        // document is === window.document.
        env.link('document');
    }
    // window.__proto__ (aka Window.prototype)
    // window.__proto__.__proto__ (aka WindowProperties.prototype)
    // window.__proto__.__proto__.__proto__ (aka EventTarget.prototype)
    env.link('__proto__', '__proto__', '__proto__');
    env.remapProto(blueRefs.document, blueRefs.DocumentProto);
    env.lazyRemapProperties(
        blueRefs.window,
        shouldUseDefaultGlobalOwnKeys
            ? (defaultGlobalOwnKeys as PropertyKeys)
            : filterWindowKeys(getFilteredGlobalOwnKeys(globalObjectShape)),
        // Chromium based browsers have a bug that nulls the result of `window`
        // getters in detached iframes when the property descriptor of `window.window`
        // is retrieved.
        // https://bugs.chromium.org/p/chromium/issues/detail?id=1305302
        keepAlive ? undefined : unforgeablePoisonedWindowKeys
    );
    if (endowments) {
        const filteredEndowments: PropertyDescriptorMap = {};
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(filteredEndowments, endowments);
        removeWindowDescriptors(filteredEndowments);
        env.remapProperties(blueRefs.window, filteredEndowments);
    }
    // We intentionally skip remapping Window.prototype because there is nothing
    // in it that needs to be remapped.
    env.lazyRemapProperties(blueRefs.EventTargetProto, blueRefs.EventTargetProtoOwnKeys);
    // We don't remap `blueRefs.WindowPropertiesProto` because it is "magical"
    // in that it provides access to elements by id.
    //
    // Once we get the iframe info ready, and all mapped, we can proceed to
    // detach the iframe only if `options.keepAlive` isn't true.
    if (keepAlive) {
        // TODO: Temporary hack to preserve the document reference in Firefox.
        // https://bugzilla.mozilla.org/show_bug.cgi?id=543435
        const { document: redDocument } = redWindow;
        ReflectApply(DocumentProtoOpen, redDocument, []);
        ReflectApply(DocumentProtoClose, redDocument, []);
    } else {
        ReflectApply(ElementProtoRemove, iframe, []);
    }
    return env;
}

function createShadowRealmVirtualEnvironment(
    globalObject: WindowProxy & typeof globalThis,
    globalObjectShape: object | null,
    providedOptions?: BrowserEnvironmentOptions
): VirtualEnvironment {
    if (typeof globalObject !== 'object' || globalObject === null) {
        throw new TypeErrorCtor('Missing global object virtualization target.');
    }
    const {
        distortionCallback,
        endowments,
        instrumentation,
        // eslint-disable-next-line prefer-object-spread
    } = ObjectAssign({ __proto__: null }, providedOptions);

    // If a globalObjectShape has been explicitly specified, reset the
    // defaultGlobalPropertyDescriptorMap to null. This will ensure that
    // the provided globalObjectShape is used to re-create the cached
    // defaultGlobalPropertyDescriptorMap.
    if (globalObjectShape !== null) {
        defaultGlobalPropertyDescriptorMap = null;
    }
    if (defaultGlobalPropertyDescriptorMap === null) {
        let sourceShapeOrOneTimeWindow = globalObjectShape!;
        let sourceIsIframe = false;
        if (globalObjectShape === null) {
            const oneTimeIframe = createDetachableIframe();
            sourceShapeOrOneTimeWindow = ReflectApply(
                HTMLIFrameElementProtoContentWindowGetter,
                oneTimeIframe,
                []
            )!;
            sourceIsIframe = true;
        }
        defaultGlobalOwnKeys = getFilteredGlobalOwnKeys(sourceShapeOrOneTimeWindow);
        if (sourceIsIframe) {
            ReflectApply(ElementProtoRemove, sourceShapeOrOneTimeWindow, []);
        }
        defaultGlobalPropertyDescriptorMap = {
            __proto__: null,
        } as unknown as PropertyDescriptorMap;
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(
            defaultGlobalPropertyDescriptorMap,
            ObjectGetOwnPropertyDescriptors(globalObject)
        );
        for (let i = 0, { length } = defaultGlobalOwnKeys; i < length; i += 1) {
            defaultGlobalOwnKeysRegistry[defaultGlobalOwnKeys[i]] = true;
        }
        for (const key in defaultGlobalPropertyDescriptorMap) {
            if (!(key in defaultGlobalOwnKeysRegistry)) {
                delete defaultGlobalPropertyDescriptorMap[key];
            }
        }
    }
    const blueRefs = getCachedGlobalObjectReferences(globalObject);
    // Create a new environment.
    const env = new VirtualEnvironment({
        blueConnector: createBlueConnector(globalObject),
        distortionCallback,
        instrumentation,
        redConnector: createRedConnector(
            ReflectApply(FunctionProtoBind, ShadowRealmProtoEvaluate, [new ShadowRealmCtor()])
        ),
    });
    linkIntrinsics(env, globalObject);
    // window
    env.link('globalThis');
    // Set globalThis.__proto__ in the sandbox to a proxy of
    // globalObject.__proto__ and with this, the entire
    // structure around window proto chain should be covered.
    env.remapProto(globalObject, blueRefs.WindowProto);
    let unsafeBlueDescMap: PropertyDescriptorMap = defaultGlobalPropertyDescriptorMap;
    if (globalObject !== window) {
        unsafeBlueDescMap = { __proto__: null } as unknown as PropertyDescriptorMap;
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(
            unsafeBlueDescMap,
            ObjectGetOwnPropertyDescriptors(globalObject)
        );
        for (const key in unsafeBlueDescMap) {
            if (!(key in defaultGlobalOwnKeysRegistry)) {
                delete unsafeBlueDescMap[key];
            }
        }
    }
    env.remapProperties(blueRefs.window, unsafeBlueDescMap);
    if (endowments) {
        const filteredEndowments: PropertyDescriptorMap = {};
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(filteredEndowments, endowments);
        removeWindowDescriptors(filteredEndowments);
        env.remapProperties(blueRefs.window, filteredEndowments);
    }
    // We remap `blueRefs.WindowPropertiesProto` to an empty object because it
    // is "magical" in that it provides access to elements by id.
    env.remapProto(blueRefs.WindowProto, ObjectCreate(blueRefs.EventTargetProto));
    return env;
}

export default SUPPORTS_SHADOW_REALM
    ? createShadowRealmVirtualEnvironment
    : createIframeVirtualEnvironment;
