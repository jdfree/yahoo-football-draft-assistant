#!/usr/bin/env python3
"""Serve the assistant to the draft page. No extension, no install.

    python3 serve.py            # then load bootstrap.js from the draft room

Chrome treats http://localhost as a trustworthy origin, so an HTTPS page can
fetch from it. CORS headers are sent because the draft page is a foreign origin.
"""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')   # always serve the current file
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'serving {os.getcwd()} on http://localhost:{PORT}')
    print('bookmarklet:')
    print(f"javascript:(function(){{var s=document.createElement('script');"
          f"s.src='http://localhost:{PORT}/bootstrap.js';document.body.appendChild(s);}})()")
    httpd.serve_forever()
