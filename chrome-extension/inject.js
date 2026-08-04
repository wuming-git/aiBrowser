(function () {
  const el = document.currentScript;
  let fp = {};
  try {
    fp = JSON.parse(decodeURIComponent(el.dataset.fp || '%7B%7D'));
  } catch (_) {}

  function define(obj, key, value) {
    try {
      Object.defineProperty(obj, key, {
        get: () => value,
        configurable: true
      });
    } catch (_) {}
  }

  if (fp.userAgent) {
    define(Navigator.prototype, 'userAgent', fp.userAgent);
    define(Navigator.prototype, 'appVersion', String(fp.userAgent).replace(/^Mozilla\//, ''));
  }
  if (fp.platform) define(Navigator.prototype, 'platform', fp.platform);
  if (fp.language) define(Navigator.prototype, 'language', fp.language);
  if (fp.languages) define(Navigator.prototype, 'languages', Object.freeze([].concat(fp.languages)));
  if (fp.hardwareConcurrency) define(Navigator.prototype, 'hardwareConcurrency', fp.hardwareConcurrency);
  if (fp.deviceMemory) define(Navigator.prototype, 'deviceMemory', fp.deviceMemory);

  if (fp.webgl) {
    const patch = (proto) => {
      if (!proto || proto.__browser168Patched) return;
      const original = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 0x9245 && fp.webgl.vendor) return fp.webgl.vendor;
        if (param === 0x9246 && fp.webgl.renderer) return fp.webgl.renderer;
        return original.call(this, param);
      };
      proto.__browser168Patched = true;
    };
    try {
      if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
    } catch (_) {}
  }

  if (fp.screen) {
    if (fp.screen.width) {
      define(Screen.prototype, 'width', fp.screen.width);
      define(Screen.prototype, 'availWidth', fp.screen.width);
    }
    if (fp.screen.height) {
      define(Screen.prototype, 'height', fp.screen.height);
      define(Screen.prototype, 'availHeight', fp.screen.height);
    }
    if (fp.screen.colorDepth) define(Screen.prototype, 'colorDepth', fp.screen.colorDepth);
    if (fp.screen.pixelRatio) define(window, 'devicePixelRatio', fp.screen.pixelRatio);
  }

  if (fp.timezone) {
    try {
      const original = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        const opts = original.call(this);
        return Object.assign({}, opts, { timeZone: fp.timezone });
      };
    } catch (_) {}
  }
})();
