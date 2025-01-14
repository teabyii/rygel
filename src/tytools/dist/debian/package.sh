#!/bin/sh -e

cd "$(dirname $0)/../../../.."

./bootstrap.sh
./felix -pDebug tycmd

VERSION=$(bin/Debug/tycmd --version | awk -F'[ _]' '/^tycmd/ {print $2}')
DATE=$(git show -s --format=%ci | LANG=en_US xargs -0 -n1 date "+%a, %d %b %Y %H:%M:%S %z" -d)
PACKAGE_DIR=bin/Packages/tytools/debian

rm -rf $PACKAGE_DIR/pkg
mkdir -p $PACKAGE_DIR $PACKAGE_DIR/pkg $PACKAGE_DIR/pkg/debian

docker build -t rygel/ubuntu2204 deploy/docker/ubuntu2204
docker run -t -i --rm -v $(pwd):/io rygel/ubuntu2204 /io/src/tytools/dist/debian/build.sh

install -D -m0755 bin/Packages/tytools/debian/bin/tycmd $PACKAGE_DIR/pkg/tycmd
install -D -m0755 bin/Packages/tytools/debian/bin/tycommander $PACKAGE_DIR/pkg/tycommander
install -D -m0755 bin/Packages/tytools/debian/bin/tyuploader $PACKAGE_DIR/pkg/tyuploader
install -D -m0644 src/tytools/tycommander/tycommander_linux.desktop $PACKAGE_DIR/pkg/TyCommander.desktop
install -D -m0644 src/tytools/tyuploader/tyuploader_linux.desktop $PACKAGE_DIR/pkg/TyUploader.desktop
install -D -m0644 src/tytools/assets/images/tycommander.png $PACKAGE_DIR/pkg/tycommander.png
install -D -m0644 src/tytools/assets/images/tyuploader.png $PACKAGE_DIR/pkg/tyuploader.png
install -D -m0644 src/tytools/dist/debian/teensy.rules $PACKAGE_DIR/pkg/00-teensy.rules

install -D -m0755 src/tytools/dist/debian/rules $PACKAGE_DIR/pkg/debian/rules
install -D -m0644 src/tytools/dist/debian/compat $PACKAGE_DIR/pkg/debian/compat
install -D -m0644 src/tytools/dist/debian/install $PACKAGE_DIR/pkg/debian/install
install -D -m0644 src/tytools/dist/debian/format $PACKAGE_DIR/pkg/debian/source/format

echo "\
Source: tytools
Section: utils
Priority: optional
Maintainer: Niels Martignène <niels.martignene@protonmail.com>
Standards-Version: 4.5.1
Rules-Requires-Root: no

Package: tytools
Architecture: any
Depends: libqt6core6, libudev1
Description: GUI and command-line tools to manage Teensy devices
" > $PACKAGE_DIR/pkg/debian/control
echo "\
tytools ($VERSION) unstable; urgency=low

  * Current release.

 -- Niels Martignène <niels.martignene@protonmail.com>  $DATE
" > $PACKAGE_DIR/pkg/debian/changelog

(cd $PACKAGE_DIR/pkg && dpkg-buildpackage -uc -us)
cp $PACKAGE_DIR/tytools_*.deb $PACKAGE_DIR/..
