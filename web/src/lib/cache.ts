// web/src/lib/cache.ts
class SessionCache {
  private cache = new Map<string, any>();

  set(key: string, value: any, ttl: number = 300000) {
    // 5 min default
    this.cache.set(key, {
      value,
      expires: Date.now() + ttl,
    });
  }

  get(key: string): any | null {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }
}

export const sessionCache = new SessionCache();
