// Millimetres from Apple's device drawings. Corner radii are visual
// approximations. The runtime bitmap remains the source of screen pixels.
type PhoneFrame = {
  screenWidth: number;
  screenHeight: number;
  bezel: number;
  rail: number;
  cornerRadius: number;
  cutout: {
    kind: "notch" | "island";
    width: number;
    height: number;
    top: number;
    bottomRadius: number;
  };
};

const PHONE_FRAMES: Readonly<Record<string, PhoneFrame>> = {
  "iPhone-12": {
    screenWidth: 64.58,
    screenHeight: 139.77,
    bezel: 3.47,
    rail: 1.55,
    cornerRadius: 7.9,
    cutout: {
      kind: "notch",
      width: 34.83,
      height: 5.3,
      top: 0,
      bottomRadius: 3.8,
    },
  },
  "iPhone-13-mini": {
    screenWidth: 57.67,
    screenHeight: 124.96,
    bezel: 3.27,
    rail: 1.05,
    cornerRadius: 6.8,
    cutout: {
      kind: "notch",
      width: 26.78,
      height: 5.77,
      top: 0,
      bottomRadius: 3.57,
    },
  },
  "iPhone-14-Pro": {
    screenWidth: 65.08,
    screenHeight: 141.09,
    bezel: 3.19,
    rail: 1.05,
    cornerRadius: 9.1,
    cutout: {
      kind: "island",
      width: 20.69,
      height: 6.07,
      top: 8.1 - 3.19 - 6.07 / 2,
      bottomRadius: 6.07 / 2,
    },
  },
  "iPhone-14-Pro-Max": {
    screenWidth: 71.21,
    screenHeight: 154.34,
    bezel: 3.19,
    rail: 1.055,
    cornerRadius: 9.17,
    cutout: {
      kind: "island",
      width: 20.76,
      height: 6.07,
      top: 8.1 - 3.19 - 6.07 / 2,
      bottomRadius: 6.07 / 2,
    },
  },
  "iPhone-17-Pro": {
    screenWidth: 66.57,
    screenHeight: 144.73,
    bezel: 2.64,
    rail: 1.2,
    cornerRadius: 66.57 * 0.147,
    cutout: {
      kind: "island",
      width: 20.76,
      height: 6.07,
      top: 7.99 - 2.64 - 6.07 / 2,
      bottomRadius: 6.07 / 2,
    },
  },
  "iPhone-17-Pro-Max": {
    screenWidth: 72.86,
    screenHeight: 158.31,
    bezel: 2.56,
    rail: 1.2,
    cornerRadius: 9.8,
    cutout: {
      kind: "island",
      width: 20.76,
      height: 6.07,
      top: 7.91 - 2.56 - 6.07 / 2,
      bottomRadius: 6.07 / 2,
    },
  },
};

export function iphoneFrame(
  deviceType: string | undefined,
): PhoneFrame | undefined {
  return deviceType && Object.hasOwn(PHONE_FRAMES, deviceType)
    ? PHONE_FRAMES[deviceType]
    : undefined;
}
