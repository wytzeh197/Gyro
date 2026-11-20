/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);

// Render the real, current Gyro UI components straight from the app checkout.
const GYRO = new URL("../../../../", "file://" + process.cwd() + "/").pathname;
const filmModules = process.cwd() + "/node_modules";
Config.overrideBundlerConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias ?? {}),
      "@gyro-ui": GYRO + "packages/ui/src",
      "lucide-react": GYRO + "packages/ui/node_modules/lucide-react",
      react: filmModules + "/react",
      "react-dom": filmModules + "/react-dom",
    },
  },
}));
