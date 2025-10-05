// src/lib/net/api.ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const id = crypto.randomUUID();
    const timeout = setTimeout(()=>controller.abort('timeout'), 15000);
    try {
      const res = await fetch(path, { ...init, headers:{'x-request-id':id, ...(init?.headers||{})}, signal: controller.signal, credentials:'include' });
      if (res.status===401) { await fetch('/api/auth/refresh',{credentials:'include'}); /* 1回だけ再試行 */ return api<T>(path, init); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as T;
    } finally { clearTimeout(timeout); }
  }
  