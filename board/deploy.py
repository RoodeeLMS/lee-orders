"""Publish the board app's CODE to the AI board and restart its container.

    python deploy.py            upload server.py/index.html/app.js/style.css, restart 'leeorders'

Code lands in /home/appdata/apps/leeorders (bind-mounted read-only into the container).
Round DATA is a separate step: _local/scripts/board_sync.py (it carries the address book,
which never lives in this repo).
"""
import pathlib
import sys
import time

sys.path.insert(0, 'E:/aiboard-platform')
from aiboard import P, upload, mkdirs   # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FILES = ['server.py', 'index.html', 'app.js', 'style.css']


def main():
    p = P()
    mkdirs(p, ['apps/leeorders', 'leedata/sync/orders'])
    upload(p, [(f, (HERE / f).read_bytes(), 0o644) for f in FILES], dest='/home/appdata/apps/leeorders')
    print('uploaded', ', '.join(FILES))
    st, _ = p.docker('POST', '/containers/leeorders/restart?t=5')
    print('restart leeorders ->', st, '(404 = container not created yet: run gen/push/deploy in E:/aiboard-platform)')
    time.sleep(3)
    st, info = p.docker('GET', '/containers/leeorders/json')
    if st == 200:
        print('state:', info['State']['Status'])


if __name__ == '__main__':
    main()
