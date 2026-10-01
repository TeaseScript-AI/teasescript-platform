export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * Plain pixel data copied out of a camera frame or decoded image: four 0–255 channels per pixel, rows top to bottom.
 * It holds no browser object, so it can be handed to package code or copied across a message boundary.
 */
export class RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, data: Uint8ClampedArray) {
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
      throw new RangeError("Image dimensions must be positive integers.");
    if (data.length !== width * height * 4)
      throw new RangeError("Image data must hold four channels per pixel.");
    this.width = width;
    this.height = height;
    this.data = data;
  }

  getPixel(x: number, y: number): Rgba {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0)
      throw new RangeError("Pixel coordinates must be non-negative integers.");
    if (x >= this.width || y >= this.height)
      throw new RangeError("Pixel coordinates are outside the image.");
    const offset = (y * this.width + x) * 4;
    const { data } = this;
    return {
      r: data[offset] ?? 0,
      g: data[offset + 1] ?? 0,
      b: data[offset + 2] ?? 0,
      a: data[offset + 3] ?? 0,
    };
  }
}
