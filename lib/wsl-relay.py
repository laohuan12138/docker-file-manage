import socket, socketserver, sys, os, threading

SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        down = self.request
        up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            up.connect(SOCK)
        except OSError as e:
            try:
                down.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            return

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(262144)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        t = threading.Thread(target=pump, args=(up, down), daemon=True)
        t.start()
        pump(down, up)
        t.join(timeout=5)
        try:
            up.close()
        except OSError:
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 23760
    sys.stderr.write("dockfile relay on 127.0.0.1:%d -> %s\n" % (port, SOCK))
    sys.stderr.flush()
    Server(("127.0.0.1", port), Handler).serve_forever()
