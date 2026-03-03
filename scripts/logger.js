// Structured logger with levels: DEBUG, INFO, WARN, ERROR
// Set LOG_LEVEL env var to control verbosity (default: INFO)

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, message, ctx) {
  if (LOG_LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;

  if (ctx && Object.keys(ctx).length > 0) {
    console.log(`${prefix} ${message}`, JSON.stringify(ctx));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

const logger = {
  debug: (msg, ctx) => log('DEBUG', msg, ctx),
  info:  (msg, ctx) => log('INFO',  msg, ctx),
  warn:  (msg, ctx) => log('WARN',  msg, ctx),
  error: (msg, ctx) => log('ERROR', msg, ctx),
};

module.exports = logger;
