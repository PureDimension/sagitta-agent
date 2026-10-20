export function createMockManager(baseUrl, { headers = {} } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, init = {}) {
      calls.push({ path, init: { ...init, headers: { ...init.headers } } });
      return await fetch(new URL(path, `${baseUrl.replace(/\/+$/, "")}/`), {
        ...init,
        headers: { ...headers, ...(init.headers || {}) },
      });
    },
  };
}

export function managerBody(call) {
  return call?.init?.body === undefined ? undefined : JSON.parse(call.init.body);
}
