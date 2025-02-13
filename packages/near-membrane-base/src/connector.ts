import { createMembraneMarshall } from './membrane';
import { toSafeWeakMap } from './utils';

export type Connector = ReturnType<typeof createMembraneMarshall>;

const TypeErrorCtor = TypeError;
const WeakMapCtor = WeakMap;

const evaluatorToRedCreateHooksCallbackMap = toSafeWeakMap(
    new WeakMapCtor<typeof eval, Connector>()
);

const globalThisToBlueCreateHooksCallbackMap = toSafeWeakMap(
    new WeakMapCtor<typeof globalThis, Connector>()
);

const createMembraneMarshallSourceInStrictMode = `
'use strict';
(${createMembraneMarshall})`;

export function createBlueConnector(globalObject: typeof globalThis): Connector {
    if (typeof globalObject !== 'object' || globalObject === null) {
        throw new TypeErrorCtor('Missing globalObject.');
    }
    let createHooksCallback = globalThisToBlueCreateHooksCallbackMap.get(globalObject);
    if (createHooksCallback === undefined) {
        createHooksCallback = createMembraneMarshall(globalObject);
        globalThisToBlueCreateHooksCallbackMap.set(globalObject, createHooksCallback);
    }
    return createHooksCallback;
}

export function createRedConnector(evaluator: typeof eval): Connector {
    if (typeof evaluator !== 'function') {
        throw new TypeErrorCtor('Missing evaluator function.');
    }
    let createHooksCallback = evaluatorToRedCreateHooksCallbackMap.get(evaluator) as
        | Connector
        | undefined;
    if (createHooksCallback === undefined) {
        createHooksCallback = evaluator(createMembraneMarshallSourceInStrictMode)() as Connector;
        evaluatorToRedCreateHooksCallbackMap.set(evaluator, createHooksCallback);
    }
    return createHooksCallback;
}
