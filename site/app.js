const frame = document.querySelector('#demo-app');
const loader = document.querySelector('#demo-loader');
const reload = document.querySelector('#reload-demo');

if (frame && loader) {
  const hide = () => loader.classList.add('hidden');
  const ready = () => {
    try {
      return Boolean(frame.contentDocument?.querySelector('.app-shell'));
    } catch {
      return true; // cross-origin fallback
    }
  };

  frame.addEventListener('load', () => {
    if (ready()) return hide();
    const timer = window.setInterval(() => {
      if (!ready()) return;
      window.clearInterval(timer);
      hide();
    }, 300);
    window.setTimeout(() => {
      window.clearInterval(timer);
      hide();
    }, 12000);
  });
}

reload?.addEventListener('click', () => {
  if (!frame || !loader) return;
  loader.classList.remove('hidden');
  frame.src = `demo/?t=${Date.now()}`;
});
