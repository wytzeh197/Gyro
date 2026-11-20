// Act-level pace. An act wrapped in <Pace speed={s}> plays s times slower: every
// component under it reads time through useFrame() instead of useCurrentFrame().
import { createContext, useContext } from "react";
import { useCurrentFrame } from "remotion";
import { frameAt, type Timing } from "./timing";

const Speed = createContext<{ speed: number; timing?: Timing }>({ speed: 1 });
export const Pace: React.FC<{ speed: number; timing?: Timing; children: React.ReactNode }> = ({ speed, timing, children }) => <Speed.Provider value={{ speed, timing }}>{children}</Speed.Provider>;
export const useFrame = () => {
  const frame = useCurrentFrame();
  const { speed, timing } = useContext(Speed);
  return timing ? frameAt(timing, frame) : frame / speed;
};
