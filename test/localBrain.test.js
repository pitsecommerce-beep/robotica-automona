import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretLocally } from '../src/brain/localBrain.js';

const state = {
  destinations: [
    { id: 'A', color: 'rojo' },
    { id: 'B', color: 'azul' },
    { id: 'C', color: 'verde' },
    { id: 'D', color: 'amarillo' },
  ],
  rules: { rojo: 'A', azul: 'B', verde: 'C', amarillo: 'D' },
};

test('rojos y azules en el mismo cajón', () => {
  const r = interpretLocally('Mete en el mismo cajón rojos y azules', state);
  assert.equal(r.confident, true);
  assert.deepEqual(r.actions, [
    { type: 'set_rule', match: 'rojo', destination: 'A' },
    { type: 'set_rule', match: 'azul', destination: 'A' },
  ]);
});

test('destino explícito por letra y por color', () => {
  assert.deepEqual(interpretLocally('lleva los verdes al cajón B', state).actions, [{ type: 'set_rule', match: 'verde', destination: 'B' }]);
  assert.deepEqual(interpretLocally('pon los amarillos en el cajón rojo', state).actions, [{ type: 'set_rule', match: 'amarillo', destination: 'A' }]);
});

test('iniciar, parar y criterio', () => {
  assert.equal(interpretLocally('Inicia la demostración', state).actions[0].type, 'start');
  assert.equal(interpretLocally('para', state).actions[0].type, 'stop');
  assert.equal(interpretLocally('ahora clasifica por SKU', state).actions[0].mode, 'sku');
});

test('charla y órdenes ambiguas pasan al cerebro en la nube', () => {
  assert.equal(interpretLocally('¿qué tal te va hoy?', state).confident, false);
  assert.equal(interpretLocally('hola robot', state).confident, false);
});
