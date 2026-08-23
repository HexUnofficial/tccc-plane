const onxrloaded = () => {
  XR8.addCameraPipelineModule(LandingPage.pipelineModule())

  /*
   * This is the fallback shown to devices that cannot run WebAR at all — a
   * desktop browser, or a phone browser without camera access. It is NOT the
   * splash a phone user sees before starting; that is the branded gate in
   * index.html, driven by gate.ts.
   *
   * Branded to match anyway, because a QR code on an unbranded grey page is
   * the first thing anyone who scans the poster on a laptop will see.
   */
  LandingPage.configure({
    logoSrc: './assets/brand/title.svg',
    logoAlt: 'next stop, SHANGHAI!',
    backgroundColor: '#F40000',
    textColor: '#ffffff',
    textShadow: true,
    mediaSrc: './assets/preview.jpg',
    mediaAlt: 'TCCC banner-towing aircraft',
    promptPrefix: 'This experience needs a phone. Scan or visit',
    promptSuffix: 'to see it.',
  })
}
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)
