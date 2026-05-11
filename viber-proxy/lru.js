/**
 * Tiny LRU cache. Used to dedupe Viber webhook deliveries by message_token.
 */
export class LRUCache {
    constructor(max = 1000) {
        this.max = max;
        this.map = new Map();
    }

    has(key) {
        if (!this.map.has(key)) return false;
        const v = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, v);
        return true;
    }

    get(key) {
        if (!this.map.has(key)) return undefined;
        const v = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }
}
