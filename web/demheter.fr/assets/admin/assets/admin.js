if (String.prototype.format == null) {
    String.prototype.format = function(...args) {
        let str = this.replace(/{(\d+)}/g, (match, idx) => {
            idx = parseInt(idx, 10) - 1;

            if (idx >= args.length)
                return match;

            let arg = args[idx];
            return (arg != null) ? arg : '';
        });

        return str;
    }
}

const Util = new function() {
    this.waitFor = function(ms) {
        return new Promise((resolve, reject) => {
            setTimeout(resolve, ms);
        });
    };

    // JS should have this!
    this.clamp = function(value, min, max) {
        if (value > max) {
            return max;
        } else if (value < min) {
            return min;
        } else {
            return value;
        }
    };

    this.getRandomInt = function(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);

        let rnd = Math.floor(Math.random() * (max - min)) + min;
        return rnd;
    };

    this.round = function(n, digits = 0) {
        return +(Math.round(n + 'e+' + digits) + 'e-' + digits);
    };

    this.saveFile = function(blob, filename) {
        let url = URL.createObjectURL(blob);

        let a = document.createElement('a');
        a.setAttribute('style', 'display: none;');
        a.download = filename;
        a.href = url;

        if (URL.revokeObjectURL) {
            setTimeout(() => {
                if (URL.revokeObjectURL != null)
                    URL.revokeObjectURL(url);
                document.body.removeChild(a);
            }, 60000);
        }

        document.body.appendChild(a);
        a.click();
    };

    this.findParent = function(el, func) {
        if (typeof func != 'function') {
            let tag = func;
            func = el => el.tagName == tag;
        }

        while (el && !func(el))
            el = el.parentElement;
        return el;
    };

    this.mapRange = function*(start, end, func) {
        for (let i = start; i < end; i++)
            yield func(i);
    };

    this.getCookie = function(key, default_value = undefined) {
        let cookies = document.cookie;
        let offset = 0;

        while (offset < cookies.length) {
            let name_end = cookies.indexOf('=', offset);
            let value_end = cookies.indexOf(';', name_end + 1);
            if (value_end < 0)
                value_end = cookies.length;

            let name = cookies.substring(offset, name_end);
            name = decodeURIComponent(name);

            if (name === key) {
                let value = cookies.substring(name_end + 1, value_end);
                value = decodeURIComponent(value);

                return value;
            }

            // Find next cookie
            offset = value_end + 1;
            while (cookies[offset] === ' ')
                offset++;
        }

        return default_value;
    };

    this.setCookie = function(name, value, options = {}) {
        let cookie = `${name}=${encodeURIComponent(value)};`;

        if (options.path != null)
            cookie += ` Path=${options.path};`;
        if (options.max_age != null)
            cookie += ` Max-Age=${options.max_age};`;
        if (options.samesite != null) {
            cookie += ` SameSite=${options.samesite};`;
        } else {
            cookie += ` SameSite=Lax;`;
        }
        if (options.secure)
            cookie += ' Secure;';

        document.cookie = cookie;
    };

    this.deleteCookie = function(name, options = {}) {
        options = Object.assign({}, options);
        options.max_age = 0;

        self.set(name, '', options);
    };
};

const Log = new function() {
    let self = this;

    let default_timeout = 3000;
    let handlers = [];

    Object.defineProperties(this, {
        defaultTimeout: { get: () => default_timeout, set: timeout => { default_timeout = timeout; }, enumerable: true }
    });

    this.pushHandler = function(func) { handlers.push(func); };
    this.popHandler = function() { handlers.pop(); };

    function updateEntry(entry, type, msg, timeout) {
        let func = handlers[handlers.length - 1];
        let is_new = (entry.type == null);

        entry.type = type;
        entry.msg = msg;

        if (entry.timer_id != null) {
            clearTimeout(entry.timer_id);
            entry.timer_id = null;
        }
        if (timeout >= 0)
            entry.timer_id = setTimeout(() => closeEntry(entry), timeout);

        func(is_new ? 'open' : 'edit', entry);

        return entry;
    }

    function closeEntry(entry) {
        if (entry.type != null) {
            let func = handlers[handlers.length - 1];
            func('close', entry);
            entry.type = null;
        }
    }

    this.Entry = function() {
        let self = this;

        this.type = null;
        this.msg = null;
        this.timer_id = null;

        this.debug = function(msg, timeout = default_timeout) { return updateEntry(self, 'debug', msg, timeout); };
        this.info = function(msg, timeout = default_timeout) { return updateEntry(self, 'info', msg, timeout); };
        this.success = function(msg, timeout = default_timeout) { return updateEntry(self, 'success', msg, timeout); };
        this.error = function(msg, timeout = default_timeout) { return updateEntry(self, 'error', msg, timeout); };

        this.progress = function(action, value = null, max = null) {
            if (value != null) {
                let msg = `${action}: ${value}${max != null ? ('/' + max) : ''}`;
                return updateEntry(self, 'progress', msg, -1);
            } else {
                return updateEntry(self, 'progress', action, -1);
            }
        };

        this.close = function() { closeEntry(self); };
    };

    this.debug = function(msg, timeout = default_timeout) { return (new self.Entry).debug(msg, timeout); };
    this.info = function(msg, timeout = default_timeout) { return (new self.Entry).info(msg, timeout); };
    this.success = function(msg, timeout = default_timeout) { return (new self.Entry).success(msg, timeout); };
    this.error = function(msg, timeout = default_timeout) { return (new self.Entry).error(msg, timeout); };
    this.progress = function(action, value = null, max = null) { return (new self.Entry).progress(action, value, max); };

    // Log to console
    this.defaultHandler = function(action, entry) {
        if (action !== 'close') {
            switch (entry.type) {
                case 'debug':
                case 'info':
                case 'success':
                case 'progress': { console.log(entry.msg); } break;
                case 'error': { console.error(entry.msg); } break;
            }
        }
    };

    handlers.push(self.defaultHandler);
};

const Net = new (function() {
    let self = this;

    let error_handler = (status) => false;

    let caches = {};

    Object.defineProperties(this, {
        errorHandler: { get: () => error_handler, set: handler => { error_handler = handler; }, enumerable: true }
    });

    this.fetch = async function(url, options = {}) {
        options = Object.assign({}, options);
        options.headers = Object.assign({ 'X-Requested-With': 'XMLHTTPRequest' }, options.headers);

        for (;;) {
            let response = await fetch(url, options);

            if (!response.ok) {
                let text = (await response.text()).trim();

                let retry = await error_handler(response.status);
                if (retry)
                    continue;

                throw new Error(text);
            }

            let json = await response.json();
            return json;
        }
    };

    this.get = async function(url) {
        return self.fetch(url);
    };

    this.post = function(url, obj = null) {
        return self.fetch(url, {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHTTPRequest'
            },
            body: JSON.stringify(obj)
        });
    };

    this.cache = async function(key, url) {
        let entry = caches[key];
        let outdated = false;

        if (entry == null) {
            entry = {
                url: null,
                data: null
            };
            caches[key] = entry;

            outdated = true;
        }
        if (entry.url != url)
            outdated = true;

        if (outdated) {
            entry.data = await self.get(url);

            if (entry.data == null) {
                delete caches[key];
                return null;
            }

            entry.url = url;
        }

        return entry.data;
    };

    this.isOutdated = function(key, url) {
        let entry = caches[key];
        let outdated = (entry == null || entry.url != url);

        return outdated;
    };

    this.invalidate = function(key) {
        delete caches[key];
    };

    this.loadScript = function(url) {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = url;

            script.onload = e => resolve(script);
            script.onerror = e => reject(new Error(`Failed to load '${url}' script`));

            document.head.appendChild(script);
        });
    };

    this.loadImage = async function(url, texture = false) {
        let img = await new Promise((resolve, reject) => {
            let img = new Image();

            img.src = url;
            img.crossOrigin = 'anonymous';

            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load texture '${url}'`));
        });

        // Fix latency spikes caused by image decoding
        if (texture && typeof createImageBitmap != 'undefined')
            img = await createImageBitmap(img);

        return img;
    };

    this.loadSound = async function(url) {
        let response = await self.fetch(url);

        let buf = await response.arrayBuffer();
        let sound = await audio.decodeAudioData(buf);

        return sound;
    };
})();

function LruMap(limit) {
    if (limit == null || limit < 2)
        throw new Error('LruMap limit must be >= 2');

    let self = this;

    let map = {};
    let size = 0;

    Object.defineProperties(this, {
        size: { get: () => size, enumerable: true }
    });

    let root_bucket = {
        prev: null,
        next: null
    };
    root_bucket.prev = root_bucket;
    root_bucket.next = root_bucket;

    function link(bucket) {
        bucket.prev = root_bucket.prev;
        bucket.next = root_bucket;
        root_bucket.prev.next = bucket;
        root_bucket.prev = bucket;
    }

    function unlink(bucket) {
        bucket.prev.next = bucket.next;
        bucket.next.prev = bucket.prev;
    }

    this.set = function(key, value) {
        let bucket = map[key];

        if (bucket) {
            bucket.value = value;

            if (root_bucket.prev !== bucket) {
                unlink(bucket);
                link(bucket);
            }
        } else {
            if (size >= limit)
                deleteBucket(root_bucket.next);

            bucket = {
                key: key,
                value: value,
                prev: null,
                next: null
            };

            map[key] = bucket;
            link(bucket);
            size++;
        }
    };

    this.delete = function(key) {
        let bucket = map[key];
        if (bucket)
            deleteBucket(bucket);
    };

    function deleteBucket(bucket) {
        unlink(bucket);
        delete map[bucket.key];
        size--;
    }

    this.get = function(key) {
        let bucket = map[key];

        if (bucket) {
            if (bucket.next !== root_bucket) {
                unlink(bucket);
                link(bucket);
            }

            return bucket.value;
        } else {
            return undefined;
        }
    };

    this.has = function(key) {
        let bucket = map[key];
        return bucket !== undefined;
    };

    this.newest = function() { return root_bucket.prev.key; };
    this.oldest = function() { return root_bucket.next.key; };

    this.clear = function() {
        root_bucket.prev = root_bucket;
        root_bucket.next = root_bucket;

        map = {};
        size = 0;
    };

    this.entries = function*() {
        let it = root_bucket.next;
        while (it !== root_bucket) {
            yield [it.key, it.value];
            it = it.next;
        }
    };
    this[Symbol.iterator] = self.entries;

    this.keys = function*() {
        let it = root_bucket.next;
        while (it !== root_bucket) {
            yield it.key;
            it = it.next;
        }
    };

    this.values = function*() {
        let it = root_bucket.next;
        while (it !== root_bucket) {
            yield it.value;
            it = it.next;
        }
    };
}

const UI = {
    this.wrap = function(func) {
        return async e => {
            let target = e.currentTarget || e.target;
            let busy = target;

            if (target.tagName == 'FORM') {
                e.preventDefault();

                // Make submit button (if any) busy
                busy = target.querySelector('button[type=submit]') || busy;
            }
            e.stopPropagation();

            if (busy.disabled || busy.classList.contains('busy'))
                return;

            try {
                if (busy.disabled != null)
                    busy.disabled = true;
                busy.classList.add('busy');

                await func(e);
            } catch (err) {
                if (err != null) {
                    Log.error(err);
                    throw err;
                }
            } finally {
                if (busy.disabled != null)
                    busy.disabled = false;
                busy.classList.remove('busy');
            }
        };
    };

    this.insist = function(func) {
        let wrapped = this.wrap(func);

        return async e => {
            let target = e.currentTarget || e.target;

            if (!target.classList.contains('insist')) {
                target.classList.add('insist');
                setTimeout(() => { target.classList.remove('insist'); }, 2000);

                if (e.target.tagName == 'FORM')
                    e.preventDefault();
                e.stopPropagation();
            } else {
                target.classList.remove('insist');
                await wrapped(e);
            }
        };
    }
}
