"""Verify actual TLS transport, Secure cookie, and HTTP refusal on the TLS port."""
from pathlib import Path
import json
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.request

from manyvo.core import Store
from manyvo.moderation import DemoModerator
from manyvo.server import AppServer


@unittest.skipUnless(shutil.which('openssl'),'OpenSSL required for temporary test certificate')
class TlsTests(unittest.TestCase):
    def test_https_cookie_and_no_plain_http_session(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder)
            cert,key=folder/'cert.pem',folder/'key.pem'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),
                            '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],check=True,capture_output=True)
            store=Store(folder/'tls.sqlite',DemoModerator())
            store.add_user('owner@test.local','Owner','owner',25,'Россия','test-password')
            server=AppServer(('127.0.0.1',0),store,tls=True)
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert,key)
            server.socket=context.wrap_socket(server.socket,server_side=True)
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                trust=ssl.create_default_context(cafile=str(cert))
                request=urllib.request.Request('https://127.0.0.1:%d/api/login'%server.server_port,
                    data=json.dumps({'email':'owner@test.local','password':'test-password'}).encode(),
                    headers={'Content-Type':'application/json','X-Manyvo-Client':'web'})
                with urllib.request.urlopen(request,context=trust,timeout=5) as response:
                    self.assertIn('; Secure',response.headers['Set-Cookie'])
                    self.assertIn('HttpOnly',response.headers['Set-Cookie'])
                    self.assertEqual(response.headers['Strict-Transport-Security'],'max-age=31536000')
                    token=response.headers['Set-Cookie'].split(';')[0]
                request=urllib.request.Request('https://127.0.0.1:%d/api/me'%server.server_port,headers={'Cookie':token})
                with urllib.request.urlopen(request,context=trust,timeout=5) as response:
                    self.assertEqual(json.load(response)['name'],'Owner')
                with socket.create_connection(('127.0.0.1',server.server_port),timeout=2) as plain:
                    plain.settimeout(2)
                    plain.sendall(b'GET /api/me HTTP/1.1\r\nHost: localhost\r\n\r\n')
                    try:
                        data=plain.recv(4096)
                    except (ConnectionResetError,TimeoutError,socket.timeout):
                        data=b''
                    self.assertNotIn(b'Set-Cookie:',data)
                    self.assertNotIn(b'Owner',data)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
