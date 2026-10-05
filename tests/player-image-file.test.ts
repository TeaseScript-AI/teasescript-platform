import assert from "node:assert/strict";
import test from "node:test";

import {
  checkImageFile,
  imagePickerAccept,
  sniffImageType,
  UNREADABLE_IMAGE_MESSAGE,
  UNSUPPORTED_IMAGE_MESSAGE,
} from "../player/image-file.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const file = (bytes: readonly number[], name: string, type = "") =>
  new File([new Uint8Array(bytes)], name, { type });
const decoded = async () => ({ width: 4, height: 3 });
const anyImage = { types: null, mime: null };

test("the image type is read from a file's first bytes, never from its name or reported type", () => {
  const cases: readonly [readonly number[], string | null][] = [
    [PNG, "image/png"],
    [JPEG, "image/jpeg"],
    [ascii("GIF89a"), "image/gif"],
    [ascii("GIF87a"), "image/gif"],
    [[...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")], "image/webp"],
    [ascii("BM"), "image/bmp"],
    [[0, 0, 0, 28, ...ascii("ftypavif")], "image/avif"],
    // An AVIF image may name avif as a compatible brand only.
    [[0, 0, 0, 32, ...ascii("ftypmif1"), 0, 0, 0, 0, ...ascii("avifmif1miafMA1B")], "image/avif"],
    [[0, 0, 0, 24, ...ascii("ftypmif1"), 0, 0, 0, 0, ...ascii("mif1heic"), ...ascii("avif")], null],
    // Formats a browser cannot be relied on to show, scriptable SVG, and other files are not images here.
    [[0, 0, 0, 24, ...ascii("ftypheic")], null],
    [ascii("<svg xmlns="), null],
    [ascii("%PDF-1.7"), null],
    [[], null],
  ];
  for (const [bytes, type] of cases) assert.equal(sniffImageType(new Uint8Array(bytes)), type);
});

test("a chosen file is stored with its sniffed type once the browser decodes it", async () => {
  const lying = await checkImageFile(file(JPEG, "photo.png", "image/png"), anyImage, decoded);
  assert.ok(lying.ok);
  assert.equal(lying.data.type, "image/jpeg");
  assert.equal(lying.data.size, JPEG.length);
  assert.deepEqual([lying.width, lying.height], [4, 3]);
  const text = await checkImageFile(
    file(ascii("hello"), "notes.png", "image/png"),
    anyImage,
    decoded,
  );
  assert.deepEqual(text, { ok: false, message: UNSUPPORTED_IMAGE_MESSAGE });
  // Bytes that look like an image but do not decode are refused too.
  const broken = await checkImageFile(file(PNG, "broken.png"), anyImage, () =>
    Promise.reject(new DOMException("", "InvalidStateError")),
  );
  assert.deepEqual(broken, { ok: false, message: UNREADABLE_IMAGE_MESSAGE });
});

test("types: and mime: both apply, to the extension and to the sniffed type", async () => {
  const filters = { types: [".PNG"], mime: ["image/png"] };
  assert.ok((await checkImageFile(file(PNG, "me.png"), filters, decoded)).ok);
  // The extension matches regardless of case, but both filters must pass.
  assert.ok((await checkImageFile(file(PNG, "ME.Png"), filters, decoded)).ok);
  for (const refused of [file(JPEG, "me.png"), file(PNG, "me.jpg"), file(PNG, "me")]) {
    const result = await checkImageFile(refused, filters, decoded);
    assert.deepEqual(result, {
      ok: false,
      message: "That image is not valid. Choose an image of these types: .PNG, image/png.",
    });
  }
  assert.ok(
    (await checkImageFile(file(JPEG, "x.bin"), { types: null, mime: ["image/jpeg"] }, decoded)).ok,
  );
});

test("the picker's accept hint lists the request's filters, or any image", () => {
  assert.equal(imagePickerAccept(anyImage), "image/*");
  assert.equal(
    imagePickerAccept({ types: [".jpg", ".png"], mime: ["image/jpeg"] }),
    ".jpg,.png,image/jpeg",
  );
});
