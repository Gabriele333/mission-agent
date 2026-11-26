/**
 * The two pages. They hold no data and no inline script or style: the script files build the
 * content from the JSON routes, with `textContent` and `createElement` only (§J.3).
 */

function page(title: string, script: string, otherLink: { href: string; text: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="/pages/style.css">
<script src="/pages/common.js" defer></script>
<script src="/pages/${script}" defer></script>
</head>
<body>
<header class="top">
<h1 id="page-title">${title}</h1>
<nav><a href="${otherLink.href}">${otherLink.text}</a></nav>
</header>
<main id="app">
<p class="muted">Loading.</p>
<noscript><p>This page needs JavaScript. JavaScript runs only from this computer: the page loads nothing from the internet.</p></noscript>
</main>
</body>
</html>
`;
}

export const SETUP_HTML = page('Setup', 'setup.js', { href: '/dashboard', text: 'Dashboard' });
export const DASHBOARD_HTML = page('Dashboard', 'dashboard.js', { href: '/setup', text: 'Setup' });
