/**
 * Over stdio, stdout carries the MCP protocol and nothing else. Anything a
 * dependency prints goes to stderr instead. Imported first so it applies before
 * any other module runs.
 */
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
