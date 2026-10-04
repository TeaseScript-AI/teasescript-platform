# XMP keyword fixtures

Small images and a sidecar with XMP `dc:subject` keywords written by real metadata tools, for
`tests/xmp-keywords.test.ts`. Made on 2026-10-04 with ffmpeg 9.0 (1×1 base images), ExifTool 13.25, and Exiv2 0.28.5,
by running these commands in this directory (Bash):

```sh
for ext in jpg png webp gif tif; do
  ffmpeg -v error -y -f lavfi -i color=c=gray:s=1x1 -frames:v 1 -fflags +bitexact -flags +bitexact \
    -map_metadata -1 "no-xmp.$ext"
done
keywords=(-XMP-dc:Subject=bedroom '-XMP-dc:Subject=Tom & Jerry <3' -XMP-dc:Subject=Café '-XMP-dc:Subject=punishment: 4')
cp no-xmp.jpg keywords.jpg
exiftool -q -overwrite_original "${keywords[@]}" '-XMP-lr:HierarchicalSubject=Rooms|bedroom' keywords.jpg
for ext in png webp gif; do
  cp "no-xmp.$ext" "keywords.$ext"
  exiftool -q -overwrite_original "${keywords[@]}" "keywords.$ext"
done
cp no-xmp.tif keywords-little-endian.tif
node make-big-endian-tiff.mjs keywords-big-endian.tif
exiftool -q -overwrite_original "${keywords[@]}" keywords-little-endian.tif keywords-big-endian.tif
exiftool -q -o keywords.jpg.xmp keywords.jpg
node compress-png-xmp.mjs keywords.png compressed-xmp.png
cp no-xmp.jpg exiv2-keywords.jpg
exiv2 -M'set Xmp.dc.subject XmpBag bedroom' -M'set Xmp.dc.subject Tom & Jerry <3' -M'set Xmp.dc.subject Café' \
  -M'set Xmp.dc.subject punishment: 4' -M'set Xmp.lr.hierarchicalSubject XmpBag Rooms|bedroom' exiv2-keywords.jpg
```

`exiftool -j -XMP-dc:Subject` reports `["bedroom", "Tom & Jerry <3", "Café", "punishment: 4"]` for every `keywords*`
file, `exiv2-keywords.jpg`, and `compressed-xmp.png`, and no subject for the `no-xmp.*` images.

- `keywords.jpg`, `keywords.jpg.xmp`, and `exiv2-keywords.jpg` also have the Lightroom hierarchical keyword
  `Rooms|bedroom` in `lr:hierarchicalSubject`.
- `keywords-big-endian.tif` starts from a hand-built big-endian TIFF because ffmpeg writes little-endian TIFF.
- ExifTool writes PNG XMP uncompressed but keeps existing compression, so `compressed-xmp.png` compresses the XMP of
  `keywords.png` itself; ExifTool reads it back.
