const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Helper to sanitize filenames
 */
function sanitizeFilename(filename) {
  return path.basename(filename || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'downloaded_file';
}

/**
 * Helper for HTTP/HTTPS requests with redirects and cookie tracking
 */
function requestWithCookies(targetUrl, options = {}, cookieJar = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      ...options.headers
    };

    // Attach existing cookies
    const cookieHeader = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    const req = client.get(targetUrl, {
      headers,
      signal: options.signal,
      timeout: options.timeout || 30000
    }, (res) => {
      // Store new cookies
      if (res.headers['set-cookie']) {
        const setCookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
        for (const c of setCookies) {
          const parts = c.split(';')[0].split('=');
          if (parts.length >= 2) {
            cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
          }
        }
      }

      // Handle Redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const maxRedirects = options.maxRedirects !== undefined ? options.maxRedirects : 7;
        if ((options.redirectCount || 0) >= maxRedirects) {
          res.resume();
          return reject(new Error('Too many HTTP redirects from Google Drive'));
        }
        res.resume();
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        return resolve(requestWithCookies(nextUrl, {
          ...options,
          redirectCount: (options.redirectCount || 0) + 1
        }, cookieJar));
      }

      resolve({ res, finalUrl: targetUrl, cookieJar });
    });

    req.on('error', (err) => {
      if (options.signal && options.signal.aborted) {
        reject(new Error('Cancelled by user'));
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy(new Error('Google Drive request timed out'));
    });
  });
}

/**
 * Fetch full body as string (used for metadata/HTML inspection)
 */
async function fetchBodyText(targetUrl, options = {}, cookieJar = {}) {
  const { res, finalUrl, cookieJar: newJar } = await requestWithCookies(targetUrl, options, cookieJar);
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      body += chunk;
      // Prevent reading huge files into memory if it's unexpectedly a binary stream
      if (body.length > 5 * 1024 * 1024) {
        res.destroy();
        resolve({ body, statusCode: res.statusCode, headers: res.headers, finalUrl, cookieJar: newJar });
      }
    });
    res.on('end', () => {
      resolve({ body, statusCode: res.statusCode, headers: res.headers, finalUrl, cookieJar: newJar });
    });
    res.on('error', reject);
  });
}

class GDriveCrawler {
  /**
   * Check if a URL belongs to Google Drive
   */
  isGoogleDriveUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();
      return host.includes('drive.google.com') ||
             host.includes('docs.google.com') ||
             host.includes('drive.usercontent.google.com');
    } catch (e) {
      return false;
    }
  }

  /**
   * Parse a Google Drive URL into { type: 'file' | 'folder', id: string }
   */
  parseUrl(urlStr) {
    if (!this.isGoogleDriveUrl(urlStr)) return null;

    try {
      const parsed = new URL(urlStr);

      // 1. Folder match /drive/folders/{id} or /folders/{id}
      const folderMatch = parsed.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (folderMatch) {
        return { type: 'folder', id: folderMatch[1] };
      }

      // 2. File match /file/d/{id}
      const fileMatch = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (fileMatch) {
        return { type: 'file', id: fileMatch[1] };
      }

      // 3. Query param id / open?id={id} / uc?id={id}
      const idParam = parsed.searchParams.get('id');
      if (idParam) {
        if (parsed.pathname.includes('folders')) {
          return { type: 'folder', id: idParam };
        }
        return { type: 'file', id: idParam };
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extracts filename from Content-Disposition header
   */
  extractFilenameFromDisposition(disposition) {
    if (!disposition) return null;
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
      try {
        return sanitizeFilename(decodeURIComponent(utf8Match[1]));
      } catch (e) {}
    }
    const match = disposition.match(/filename="?([^";]+)"?/i);
    if (match && match[1]) {
      return sanitizeFilename(match[1]);
    }
    return null;
  }

  /**
   * Resolves direct download stream for a Google Drive file or Google Doc,
   * bypassing Google's virus scan confirmation warning (>100MB files).
   */
  async openDownloadStream(urlOrFileId, signal = null) {
    // Case A: Google Docs/Sheets/Slides Export URL
    if (typeof urlOrFileId === 'string' && (urlOrFileId.includes('docs.google.com/') || urlOrFileId.includes('/export'))) {
      const { res, finalUrl } = await requestWithCookies(urlOrFileId, {
        signal,
        headers: {
          'Accept': '*/*',
          'User-Agent': USER_AGENT
        }
      });

      if (res.statusCode >= 400) {
        res.resume();
        throw new Error(`Google Docs export failed with HTTP ${res.statusCode}`);
      }

      const disposition = res.headers['content-disposition'];
      const contentType = res.headers['content-type'] || 'application/octet-stream';
      const contentLength = parseInt(res.headers['content-length'], 10);
      const filename = this.extractFilenameFromDisposition(disposition) || 'exported_document';

      return {
        stream: res,
        filename,
        totalSize: !isNaN(contentLength) && contentLength > 0 ? contentLength : 0,
        contentType
      };
    }

    // Case B: Standard Google Drive File
    let fileId = urlOrFileId;
    const parsed = this.parseUrl(urlOrFileId);
    if (parsed && parsed.type === 'file') {
      fileId = parsed.id;
    }

    const cookieJar = {};
    const primaryUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

    const { res: firstRes, finalUrl: firstFinalUrl, cookieJar: updatedJar } = await requestWithCookies(primaryUrl, {
      signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    }, cookieJar);

    if (firstRes.statusCode >= 400) {
      firstRes.resume();
      throw new Error(`Google Drive returned HTTP ${firstRes.statusCode}`);
    }

    const contentType = firstRes.headers['content-type'] || '';
    const disposition = firstRes.headers['content-disposition'];
    const isHtml = contentType.includes('text/html');

    // Case 1: Direct file download response (binary content or disposition present)
    if (!isHtml || (disposition && !disposition.includes('inline'))) {
      const filename = this.extractFilenameFromDisposition(disposition) || `gdrive_${fileId}`;
      const contentLength = parseInt(firstRes.headers['content-length'], 10);
      return {
        stream: firstRes,
        filename,
        totalSize: !isNaN(contentLength) && contentLength > 0 ? contentLength : 0,
        contentType: contentType || 'application/octet-stream'
      };
    }

    // Case 2: Google Virus warning confirmation page
    const bodyChunks = [];
    for await (const chunk of firstRes) {
      bodyChunks.push(chunk);
      if (bodyChunks.reduce((acc, c) => acc + c.length, 0) > 2 * 1024 * 1024) break;
    }
    const html = Buffer.concat(bodyChunks).toString('utf8');

    // Check if it's an error page (e.g. 404 Not Found or Access Denied)
    if (html.includes('404 (Not Found)') || html.includes('This file does not exist') || html.includes('Access Denied')) {
      throw new Error('Google Drive file not found or private. Ensure sharing is set to "Anyone with the link".');
    }

    // Extract filename from HTML title or metadata if available
    let detectedFilename = null;
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch && !titleMatch[1].includes('Virus scan warning') && !titleMatch[1].includes('Google Drive')) {
      detectedFilename = sanitizeFilename(titleMatch[1]);
    }

    // Look for confirmation form or download link
    let confirmUrl = null;

    // Pattern A: <form action="https://drive.usercontent.google.com/download" ...>
    const formMatch = html.match(/<form[^>]+id=["']download-form["'][^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i) ||
                     html.match(/<form[^>]+action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
    if (formMatch) {
      const action = formMatch[1].replace(/&amp;/g, '&');
      const formHtml = formMatch[2];
      const params = new URLSearchParams();

      const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["'][^>]*>/gi;
      let inputMatch;
      while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
        params.append(inputMatch[1], inputMatch[2]);
      }

      if (!params.has('id')) params.set('id', fileId);
      if (!params.has('export')) params.set('export', 'download');
      if (!params.has('confirm')) params.set('confirm', 't');

      const actionUrl = new URL(action, firstFinalUrl);
      params.forEach((val, key) => actionUrl.searchParams.set(key, val));
      confirmUrl = actionUrl.toString();
    }

    // Pattern B: <a id="uc-download-link" href="..."> or <a href="/uc?export=download&confirm=...">
    if (!confirmUrl) {
      const linkMatch = html.match(/<a[^>]+id=["']uc-download-link["'][^>]+href=["']([^"']+)["']/i) ||
                        html.match(/<a[^>]+href=["'](\/uc\?export=download[^"']+)["']/i) ||
                        html.match(/<a[^>]+href=["'](https:\/\/drive\.usercontent\.google\.com\/download[^"']+)["']/i);
      if (linkMatch) {
        confirmUrl = new URL(linkMatch[1].replace(/&amp;/g, '&'), firstFinalUrl).toString();
      }
    }

    // Pattern C: Token confirm code in HTML
    if (!confirmUrl) {
      const confirmTokenMatch = html.match(/confirm=([0-9a-zA-Z_-]+)/i) || html.match(/download_warning_([0-9a-zA-Z_-]+)/i);
      if (confirmTokenMatch) {
        confirmUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirmTokenMatch[1]}`;
      }
    }

    // Fallback: Default confirm=t on usercontent endpoint
    if (!confirmUrl) {
      confirmUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    }

    // Execute the confirmed download request
    const { res: secondRes } = await requestWithCookies(confirmUrl, {
      signal,
      headers: {
        'Referer': firstFinalUrl,
        'Accept': '*/*'
      }
    }, updatedJar);

    if (secondRes.statusCode >= 400) {
      secondRes.resume();
      throw new Error(`Google Drive download failed with HTTP ${secondRes.statusCode}`);
    }

    const secondContentType = secondRes.headers['content-type'] || '';
    const secondDisposition = secondRes.headers['content-disposition'];
    const resolvedFilename = this.extractFilenameFromDisposition(secondDisposition) || detectedFilename || `gdrive_file_${fileId}`;
    const contentLength = parseInt(secondRes.headers['content-length'], 10);

    return {
      stream: secondRes,
      filename: resolvedFilename,
      totalSize: !isNaN(contentLength) && contentLength > 0 ? contentLength : 0,
      contentType: secondContentType || 'application/octet-stream'
    };
  }

  /**
   * Crawl a public Google Drive folder recursively
   * @param {string} folderId 
   * @param {number} maxDepth Maximum recursion depth (default: 5)
   * @returns {Promise<Object>} { id, name, files: [], subfolders: [] }
   */
  async crawlFolder(folderId, maxDepth = 5, currentDepth = 0) {
    const cleanFolderId = String(folderId).trim();
    const result = {
      id: cleanFolderId,
      name: 'Google Drive Folder',
      files: [],
      subfolders: []
    };

    if (currentDepth >= maxDepth) return result;

    // Optional: Google Drive v3 API Key if configured in env
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GDRIVE_API_KEY;
    if (apiKey) {
      try {
        return await this._crawlFolderViaApi(cleanFolderId, apiKey, maxDepth, currentDepth);
      } catch (err) {
        console.warn(`[GDriveCrawler] API crawl failed for folder ${cleanFolderId}, falling back to web scraper:`, err.message);
      }
    }

    // Web Scraping fallback (zero API key required)
    return await this._crawlFolderViaWeb(cleanFolderId, maxDepth, currentDepth);
  }

  /**
   * Crawls public folder via Google Drive public web interface
   */
  async _crawlFolderViaWeb(folderId, maxDepth, currentDepth) {
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
    const { body: html, statusCode } = await fetchBodyText(folderUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (statusCode === 404 || statusCode === 403) {
      throw new Error(`Google Drive folder is private or not accessible (HTTP ${statusCode}). Please open the folder on Google Drive, click "Share", set General access to "Anyone with the link (Viewer)", and copy the link again.`);
    }

    if (statusCode < 200 || statusCode >= 400) {
      throw new Error(`Google Drive returned status ${statusCode}. Make sure the folder is shared with "Anyone with the link".`);
    }

    // 1. Check for folder title in ds:1 or HTML meta
    let folderName = 'Google Drive Folder';
    const ds1Match = html.match(/AF_initDataCallback\(\{key:\s*'ds:1'[\s\S]*?data:[\s\S]*?\["([a-zA-Z0-9_-]+)",\s*null,\s*"([^"]+)"/);
    if (ds1Match && ds1Match[2]) {
      folderName = ds1Match[2];
    } else {
      const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (ogTitleMatch && ogTitleMatch[1]) {
        folderName = ogTitleMatch[1].trim();
      } else if (titleMatch && titleMatch[1]) {
        folderName = titleMatch[1].replace(' - Google Drive', '').trim() || folderName;
      }
    }

    const itemsMap = new Map();

    const decodeHex = (str) => {
      if (!str) return '';
      return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    };

    // 2. Decode window['_DRIVE_ivd'] hex-encoded payload
    const ivdMatches = [
      ...html.matchAll(/window\['_DRIVE_ivd'\]\s*=\s*'([^']+)'/gs),
      ...html.matchAll(/_DRIVE_ivd\s*=\s*'([^']+)'/gs)
    ];

    for (const match of ivdMatches) {
      try {
        let decoded = decodeHex(match[1]).replace(/\\\//g, '/');

        // Pattern A: [ "ID", [ "PARENT_ID" ... ], "NAME", "MIME_TYPE" ... ]
        const itemRegexA = /\["([a-zA-Z0-9_-]{25,45})",\s*\[[^\]]*\],\s*"([^"]+)",\s*"([^"]+)"(?:,\s*(\d+))?/g;
        let mA;
        while ((mA = itemRegexA.exec(decoded)) !== null) {
          const id = mA[1];
          const name = mA[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const mimeType = mA[3];
          const size = parseInt(mA[4] || '0', 10) || 0;
          if (id && name && id !== folderId) {
            itemsMap.set(id, { id, name: sanitizeFilename(name), mimeType, size });
          }
        }

        // Pattern B: [ "ID", null, "NAME", "MIME_TYPE" ... ]
        const itemRegexB = /\["([a-zA-Z0-9_-]{25,45})",\s*null,\s*"([^"]+)",\s*"([^"]+)"(?:,\s*(\d+))?/g;
        let mB;
        while ((mB = itemRegexB.exec(decoded)) !== null) {
          const id = mB[1];
          const name = mB[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const mimeType = mB[3];
          const size = parseInt(mB[4] || '0', 10) || 0;
          if (id && name && id !== folderId && !itemsMap.has(id)) {
            itemsMap.set(id, { id, name: sanitizeFilename(name), mimeType, size });
          }
        }
      } catch (e) {}
    }

    // 3. AF_initDataCallback blobs
    const callbackRegex = /AF_initDataCallback\(\s*\{[\s\S]*?data:\s*([\s\S]*?)(?:,\s*sideChannel:|\}\);)/g;
    let cbMatch;
    while ((cbMatch = callbackRegex.exec(html)) !== null) {
      try {
        const rawBlob = cbMatch[1].replace(/\\\//g, '/');
        const itemRegexC = /\["([a-zA-Z0-9_-]{25,45})",\s*(?:\[[^\]]*\]|null),\s*"([^"]+)",\s*"([^"]+)"/g;
        let mC;
        while ((mC = itemRegexC.exec(rawBlob)) !== null) {
          const id = mC[1];
          const name = mC[2].replace(/\\"/g, '"');
          const mimeType = mC[3];
          if (id && name && id !== folderId && !itemsMap.has(id)) {
            itemsMap.set(id, { id, name: sanitizeFilename(name), mimeType, size: 0 });
          }
        }
      } catch (e) {}
    }

    // 4. Fallback: file IDs with extensions in raw HTML
    if (itemsMap.size === 0) {
      const patternExt = /"([a-zA-Z0-9_-]{25,45})"[^"]{1,100}"([^"\\]+\.(?:mp4|mkv|avi|mov|mp3|wav|flac|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|tar|gz|apk|exe|iso|jpg|jpeg|png|webp|gif|txt|csv|json|py|js|html))"/gi;
      let mExt;
      while ((mExt = patternExt.exec(html)) !== null) {
        const id = mExt[1];
        const name = mExt[2];
        if (id && name && id !== folderId && !itemsMap.has(id)) {
          itemsMap.set(id, { id, name: sanitizeFilename(name), mimeType: 'application/octet-stream', size: 0 });
        }
      }
    }

    const files = [];
    const subfolderPromises = [];

    for (const item of itemsMap.values()) {
      if (item.id === folderId) continue;

      if (item.mimeType === 'application/vnd.google-apps.folder') {
        if (currentDepth + 1 < maxDepth) {
          subfolderPromises.push(
            this._crawlFolderViaWeb(item.id, maxDepth, currentDepth + 1).then(sub => ({
              ...sub,
              name: item.name || sub.name
            })).catch(() => null)
          );
        }
      } else {
        // Resolve download URLs based on Google Apps types
        let downloadUrl = `https://drive.google.com/uc?export=download&id=${item.id}`;
        let fileName = item.name;

        if (item.mimeType === 'application/vnd.google-apps.document') {
          downloadUrl = `https://docs.google.com/document/d/${item.id}/export?format=docx`;
          if (!fileName.toLowerCase().endsWith('.docx')) fileName += '.docx';
        } else if (item.mimeType === 'application/vnd.google-apps.spreadsheet') {
          downloadUrl = `https://docs.google.com/spreadsheets/d/${item.id}/export?format=xlsx`;
          if (!fileName.toLowerCase().endsWith('.xlsx')) fileName += '.xlsx';
        } else if (item.mimeType === 'application/vnd.google-apps.presentation') {
          downloadUrl = `https://docs.google.com/presentation/d/${item.id}/export/pptx`;
          if (!fileName.toLowerCase().endsWith('.pptx')) fileName += '.pptx';
        }

        files.push({
          id: item.id,
          name: fileName,
          size: item.size || 0,
          mimeType: item.mimeType || 'application/octet-stream',
          downloadUrl
        });
      }
    }

    const subfolders = (await Promise.all(subfolderPromises)).filter(Boolean);

    return {
      id: folderId,
      name: sanitizeFilename(folderName),
      files,
      subfolders
    };
  }

  /**
   * Helper to recursively traverse raw nested arrays and find file/folder items
   */
  _extractItemsFromArray(node, itemsMap) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      // Check if this array matches a Google Drive item structure:
      // Typically: [id, [some_prop], name, mimeType, ...] or [id, name, mimeType, ...]
      if (
        node.length >= 4 &&
        typeof node[0] === 'string' &&
        /^[a-zA-Z0-9_-]{25,45}$/.test(node[0])
      ) {
        const id = node[0];
        let name = null;
        let mimeType = null;
        let size = 0;

        for (let i = 1; i < Math.min(node.length, 15); i++) {
          const val = node[i];
          if (!name && typeof val === 'string' && val.length > 0 && !val.includes('/')) {
            name = val;
          } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string' && !name) {
            name = val[0];
          }

          if (typeof val === 'string' && (val.includes('/') || val.startsWith('application/'))) {
            mimeType = val;
          }

          if (typeof val === 'number' && val > 0 && Number.isInteger(val) && val > size) {
            size = val;
          }
        }

        if (name) {
          itemsMap.set(id, {
            id,
            name: sanitizeFilename(name),
            mimeType: mimeType || 'application/octet-stream',
            size
          });
        }
      }

      for (const child of node) {
        this._extractItemsFromArray(child, itemsMap);
      }
    } else if (typeof node === 'object') {
      for (const key of Object.keys(node)) {
        this._extractItemsFromArray(node[key], itemsMap);
      }
    }
  }

  /**
   * Official Google Drive v3 API Crawler (used if user configures GOOGLE_API_KEY)
   */
  async _crawlFolderViaApi(folderId, apiKey, maxDepth, currentDepth) {
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name&key=${apiKey}`;
    const { body: metaBody, statusCode: metaStatus } = await fetchBodyText(metaUrl);
    let folderName = 'Google Drive Folder';
    if (metaStatus === 200) {
      try {
        const parsedMeta = JSON.parse(metaBody);
        if (parsedMeta.name) folderName = parsedMeta.name;
      } catch (e) {}
    }

    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=1000&key=${apiKey}`;
    const { body: listBody, statusCode: listStatus } = await fetchBodyText(listUrl);
    if (listStatus !== 200) {
      throw new Error(`Google API request failed with status ${listStatus}`);
    }

    const parsedList = JSON.parse(listBody);
    const rawFiles = parsedList.files || [];

    const files = [];
    const subfolderPromises = [];

    for (const item of rawFiles) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        if (currentDepth + 1 < maxDepth) {
          subfolderPromises.push(
            this._crawlFolderViaApi(item.id, apiKey, maxDepth, currentDepth + 1)
          );
        }
      } else {
        files.push({
          id: item.id,
          name: sanitizeFilename(item.name),
          size: parseInt(item.size || '0', 10) || 0,
          mimeType: item.mimeType || 'application/octet-stream',
          downloadUrl: `https://drive.google.com/uc?export=download&id=${item.id}`
        });
      }
    }

    const subfolders = await Promise.all(subfolderPromises);

    return {
      id: folderId,
      name: sanitizeFilename(folderName),
      files,
      subfolders
    };
  }
}

module.exports = new GDriveCrawler();
