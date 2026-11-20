/* Decides "lite" mode (smart TVs / slow screens) before the page draws. Plain old JavaScript on purpose:
   it must run on the oldest TV browsers.
   - ?lite=1 → lite on this screen, remembered from now on      - ?lite=0 → full mode, remembered
   - otherwise: TV-like browsers and weak devices get lite; a screen that turns out slow switches to lite too. */
(function () {
  var q = location.search, saved = null;
  try { saved = localStorage.getItem('goat-lite'); } catch (e) {}
  if (/[?&]lite=1\b/.test(q)) { saved = '1'; try { localStorage.setItem('goat-lite', '1'); } catch (e) {} }
  if (/[?&]lite=0\b/.test(q)) { saved = '0'; try { localStorage.setItem('goat-lite', '0'); } catch (e) {} }
  var ua = navigator.userAgent || '';
  var tv = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|NetCast|BRAVIA|HbbTV|AFT[A-Z]|CrKey|GoogleTV|Android ?TV|AndroidTV|VIDAA|Hisense|PhilipsTV|Roku|Opera TV|OMI\/|Viera|AQUOS|SonyCEBrowser|\bTV\b|; ?wv\).*Large Screen/i.test(ua);
  var weak = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
  try { if (!tv && window.matchMedia && matchMedia('(hover: none)').matches && Math.max(screen.width, screen.height) >= 1280 && !matchMedia('(pointer: coarse)').matches) tv = true; } catch (e) {} // big screen, no mouse, no touch = a TV
  if (/[?&]tv=1\b/.test(q)) { saved = '1'; try { localStorage.setItem('goat-lite', '1'); } catch (e) {} }
  var lite = saved === '1' || (saved !== '0' && (tv || weak));
  window.GOAT_LITE = lite;
  window.GOAT_LITE_LOCKED = saved === '1' || saved === '0';
  if (lite) document.documentElement.className += ' lite';
  // Speed check once the page has settled: if frames are slow, switch this page to lite (not remembered).
  if (!lite && saved !== '0' && window.requestAnimationFrame) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        var gaps = [], last = 0;
        requestAnimationFrame(function probe(t) {
          if (last) gaps.push(t - last);
          last = t;
          if (gaps.length < 30) return requestAnimationFrame(probe);
          gaps.sort(function (a, b) { return a - b; });
          if (gaps[15] > 30) {
            window.GOAT_LITE = true;
            if (document.documentElement.className.indexOf('lite') < 0) document.documentElement.className += ' lite';
            if (window.onGoatLite) window.onGoatLite();
          }
        });
      }, 800);
    });
  }
})();
