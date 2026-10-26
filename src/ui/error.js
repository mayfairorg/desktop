const q = new URLSearchParams(location.search);
const url = q.get('u') || '', desc = q.get('e') || '', code = q.get('c') || '', home = q.get('h') === '1';
const text = {
  ERR_INTERNET_DISCONNECTED: 'You are offline. Check your connection and try again.',
  ERR_NAME_NOT_RESOLVED: 'The address could not be found. Check the spelling.',
  ERR_CONNECTION_REFUSED: 'The site refused the connection.',
  ERR_CONNECTION_TIMED_OUT: 'The site took too long to answer.',
  ERR_CERT_AUTHORITY_INVALID: 'The site security certificate is not trusted, so the page was not opened.',
  ERR_CERT_DATE_INVALID: 'The site security certificate has expired, so the page was not opened.',
  ERR_CERT_COMMON_NAME_INVALID: 'The certificate does not match this address, so the page was not opened.',
};
const key = desc.replace(/^net::/, '');
document.getElementById('h').textContent = home ? 'Mayfair is not reachable' : 'This page did not load';
document.getElementById('m').textContent = text[key] || (home ? 'Check your connection. Your work is safe in the Cloud.' : 'Something went wrong while opening it.') + (desc ? ' (' + desc + ')' : '');
document.getElementById('u').textContent = url;
document.getElementById('retry').addEventListener('click', () => { if (/^https?:/i.test(url)) location.replace(url); else history.back(); });
