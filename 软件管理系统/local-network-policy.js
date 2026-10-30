function allowedRequest(requestUrl, companyUrl) {
  try {
    const request = new URL(requestUrl);
    if (['file:', 'data:', 'devtools:', 'chrome-devtools:'].includes(request.protocol)) return true;
    if (request.protocol === 'blob:') return new URL(request.pathname).origin === new URL(companyUrl).origin;
    if (!['http:', 'https:'].includes(request.protocol)) return false;
    return request.origin === new URL(companyUrl).origin && !request.username && !request.password;
  } catch { return false; }
}
module.exports = { allowedRequest };
