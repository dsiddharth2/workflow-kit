import { DOER, REVIEWER } from './roster.mjs';

// Only the two member-addressed calls are remapped. registerMember,
// fleetStatus, listMembers and everything else pass straight through, and so
// does any member_name that is not a reserved keyword -- diagnostics can still
// target a literal member. Existing members are uppercase by convention, so
// the two namespaces cannot collide.
const REMAPPED = new Set(['executeCommand', 'executePrompt']);

export function createPooledFleetApi(fleetApi, lease) {
  const resolve = (name) => {
    if (name === DOER) return lease.doer.name;
    if (name === REVIEWER) return lease.reviewer.name;
    return name;
  };

  return new Proxy(fleetApi, {
    get(target, prop, receiver) {
      if (REMAPPED.has(prop) && typeof target[prop] === 'function') {
        return (options = {}) =>
          target[prop]({ ...options, member_name: resolve(options.member_name) });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
