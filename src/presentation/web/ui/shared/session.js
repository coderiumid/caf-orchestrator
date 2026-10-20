(function () {
  'use strict';
  // Log out buttons (.js-logout): drop the session cookie, then go to the login page.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest('.js-logout')) return;
    fetch('/dashboard/logout', { method: 'POST' }).finally(function () {
      location.assign('/dashboard/login');
    });
  });
})();
