import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  UserRoundIcon,
  type SettingsSectionId,
} from "@gyro-dev/ui";
import { verifiedV3Client, type V3Invoke } from "./cloud-v3-client";
import type { CloudProfile } from "./cloud-v3-layout";
import "./account-settings.css";

const native: V3Invoke = (request) => invoke("cloud_v3", { request });

/** Only display fields cross the native boundary. No subscription is inferred. */
export function CloudV3Navigation({
  selected,
  onSelect,
  call: rawCall = native,
}: {
  selected: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  call?: V3Invoke;
}) {
  const call = useMemo(() => verifiedV3Client(rawCall), [rawCall]);
  const [connected, setConnected] = useState(false);
  const [profile, setProfile] = useState<CloudProfile | null>(null);
  useEffect(() => {
    let active = true,
      revision = 0;
    async function refresh() {
      const current = ++revision;
      try {
        const view = await call({ operation: "view" });
        const nextProfile = view.connected
          ? await call({ operation: "profile" }).catch(() => null)
          : null;
        if (!active || current !== revision) return;
        setConnected(view.connected);
        setProfile(nextProfile);
      } catch {
        if (active && current === revision) {
          setConnected(false);
          setProfile(null);
        }
      }
    }
    void refresh();
    window.addEventListener("gyro-cloud-v3-account-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("gyro-cloud-v3-account-changed", refresh);
    };
  }, [call]);
  const initials = profile?.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((v) => v[0])
    .join("")
    .toUpperCase();
  return (
    <div className="gyro-account-navigation">
      <button
        type="button"
        className={selected === "account" ? "is-active" : ""}
        aria-current={selected === "account" ? "page" : undefined}
        onClick={() => onSelect("account")}
      >
        <span className="gyro-account-profile-avatar" aria-hidden="true">
          {initials || <UserRoundIcon size={15} />}
        </span>
        <span className="gyro-account-navigation-text">
          <strong>{profile?.displayName || "Gyro Account"}</strong>
          <small>
            {connected
              ? profile?.displayName
                ? "Gyro Account"
                : "Signed in"
              : "Optional"}
          </small>
        </span>
      </button>

    </div>
  );
}
