import { formatWithOptions } from 'node:util';

const STATE_KEY = Symbol.for('ark.receptionist.ordered-log');

if (!globalThis[STATE_KEY]) {
  const state = { sequence: 0 };
  globalThis[STATE_KEY] = state;

  const emit = (level, values) => {
    state.sequence += 1;
    const sequence = String(state.sequence).padStart(6, '0');
    const timestamp = new Date().toISOString();
    const message = formatWithOptions(
      { colors: false, depth: 6, breakLength: Infinity, compact: true },
      ...values,
    );
    process.stdout.write(`[${sequence}] ${timestamp} ${level.toUpperCase()} ${message}\n`);
  };

  console.log = (...values) => emit('info', values);
  console.info = (...values) => emit('info', values);
  console.debug = (...values) => emit('debug', values);
  console.warn = (...values) => emit('warn', values);
  console.error = (...values) => emit('error', values);

  console.log('[Ordered logging enabled]', { stream: 'stdout', sequenceStart: 1 });
}
