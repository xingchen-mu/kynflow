const frame = document.querySelector('#demo-app');
const loader = document.querySelector('#demo-loader');

if (frame && loader) {
  const hide = () => loader.classList.add('hidden');
  const ready = () => {
    try {
      return Boolean(frame.contentDocument?.querySelector('.app-shell'));
    } catch {
      return true;
    }
  };

  const timer = window.setInterval(() => {
    if (!ready()) return;
    window.clearInterval(timer);
    hide();
  }, 250);

  window.setTimeout(() => {
    window.clearInterval(timer);
    hide();
  }, 12000);
}
