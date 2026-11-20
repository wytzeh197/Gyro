import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** Modules of light margin a scanner needs around the code. */
const QUIET_ZONE = 4;

/**
 * Renders a pairing invitation as a QR code, locally: the invitation never
 * leaves this Mac. The code is always dark on light so phone cameras read it
 * in both themes.
 */
export function PairQr({
  value,
  label,
  faded = false,
}: {
  value: string;
  label: string;
  faded?: boolean;
}) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row += 1)
      for (let col = 0; col < count; col += 1)
        if (code.isDark(row, col))
          d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    return { size: count + QUIET_ZONE * 2, path: d };
  }, [value]);
  return (
    <div className={`gyro-remote-qr${faded ? " is-faded" : ""}`}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
      >
        <path d={path} />
      </svg>
    </div>
  );
}
