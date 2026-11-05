import shutil, pathlib
src=pathlib.Path("src"); out=pathlib.Path("dist"); shutil.rmtree(out,ignore_errors=True); out.mkdir()
app=(src/"app.html").read_text()
head,body=app.split("</style>",1); head+="</style>"
head=head.replace('<meta name="claude:viewport-fit-sides" content="cover">\n','')
extra='''<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14213d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Andén">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="favicon.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
'''
(out/"index.html").write_text("<!doctype html>\n<html lang=\"es\">\n<head>\n"+extra+head+"\n</head>\n<body>"+body+"</body>\n</html>\n")
for f in ["sw.js","manifest.webmanifest","icon-192.png","icon-512.png","icon-maskable-512.png","apple-touch-icon.png","favicon.png"]:
    shutil.copy(src/f,out/f)
print("ok")
