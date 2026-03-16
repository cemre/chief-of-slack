// block-slack-protocol.js — injected into page context to block slack:// protocol launches
(function() {
  const _open = window.open;
  window.open = function(url) {
    if (typeof url === 'string' && url.startsWith('slack://')) {
      console.log('[fslack] Blocked window.open slack://', url);
      return null;
    }
    return _open.apply(this, arguments);
  };

  const _assign = location.assign.bind(location);
  const _replace = location.replace.bind(location);

  location.assign = function(url) {
    if (typeof url === 'string' && url.startsWith('slack://')) {
      console.log('[fslack] Blocked location.assign slack://', url);
      return;
    }
    return _assign(url);
  };
  location.replace = function(url) {
    if (typeof url === 'string' && url.startsWith('slack://')) {
      console.log('[fslack] Blocked location.replace slack://', url);
      return;
    }
    return _replace(url);
  };

  // Block hidden iframes that trigger slack:// protocol
  const _createElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    const el = _createElement(tag);
    if (tag.toLowerCase() === 'iframe') {
      const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
      if (srcDesc) {
        Object.defineProperty(el, 'src', {
          set: function(val) {
            if (typeof val === 'string' && val.startsWith('slack://')) {
              console.log('[fslack] Blocked iframe src slack://', val);
              return;
            }
            srcDesc.set.call(this, val);
          },
          get: function() { return srcDesc.get.call(this); }
        });
      }
    }
    return el;
  };
})();
