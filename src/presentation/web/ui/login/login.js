(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var submit = document.getElementById('login-submit');
  var error = document.getElementById('login-error');

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    submit.disabled = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    fetch('/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value,
      }),
    })
      .then(function (r) {
        if (r.ok) { location.assign('/dashboard'); return; }
        fail(r.status === 401 ? 'Wrong username or password.' : 'Sign in failed (HTTP ' + r.status + ').');
      })
      .catch(function () { fail('Server unreachable. Try again.'); });
  });
})();
