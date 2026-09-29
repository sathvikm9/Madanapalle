import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  currentPushSubscription,
  DEFAULT_NOTIFICATION_PREFERENCES,
  disablePushNotifications,
  enablePushNotifications,
  loadNotificationPreferences,
  notificationSupport,
  showTestNotification,
  storeNotificationPreferences,
  updatePushPreferences
} from "./notifications.js";

const FALLBACK_VENUES = [
  { code: "SKMD", name: "Sri Krishna" },
  { code: "SCM", name: "Sai Chitra" },
  { code: "RTDM", name: "Ravi" },
  { code: "ASRM", name: "ASR" }
];

const NOTIFICATION_TYPES = [
  {
    code: "period_results",
    title: "Show-period results",
    description: "One grouped result after Early Morning, Morning, Matinee, Evening or Second shows finish."
  },
  {
    code: "schedule_changes",
    title: "Schedule changes",
    description: "Immediate alerts when a movie or showtime is replaced."
  },
  {
    code: "daily_summary",
    title: "Daily summary",
    description: "Movie-wise gross after every selected theatre finishes for the day."
  }
];

const PREVIEW_RESULTS = {
  SKMD: { collectionPaise: 3412500, line: "Sri Krishna · 11:10 AM — Mandaadi · ₹34,125" },
  RTDM: { collectionPaise: 3175000, line: "Ravi · 10:45 AM — The Paradise · ₹31,750" },
  SCM: { collectionPaise: 3881000, line: "Sai Chitra · 11:20 AM — Mandaadi · ₹38,810" },
  ASRM: { collectionPaise: 2960000, line: "ASR · 11:15 AM — Irumudi · ₹29,600" }
};

const STATIC_PREVIEWS = {
  schedule_changes: {
    label: "Schedule",
    title: "Schedule change",
    body: "Ravi · 1:45 PM Mandaadi changed to 2:00 PM The Paradise"
  },
  daily_summary: {
    label: "Daily summary",
    title: "27th September - All theatres",
    body: [
      "The Paradise - 9 Shows - 6,69,040/-",
      "Devara - Part 1 - 2 Shows - 1,09,106/-",
      "Irumudi - 4 Shows - 72,620/-",
      "Avengers Endgame: Encore - 2 Shows - 41,580/-",
      "Mandaadi - 1 Show - 3,895/-"
    ].join("\n")
  }
};

function toggleValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export default function NotificationSettings({ apiBase, preview = false }) {
  const [open, setOpen] = useState(preview);
  const [config, setConfig] = useState({ available: preview, venues: FALLBACK_VENUES, publicKey: "preview" });
  const [preferences, setPreferences] = useState(loadNotificationPreferences);
  const [subscription, setSubscription] = useState(null);
  const [adoption, setAdoption] = useState(null);
  const [previewType, setPreviewType] = useState("period_results");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const support = useMemo(notificationSupport, []);
  const allSelected = preferences.venues.length === config.venues.length;
  const enabled = Boolean(subscription);
  const canSave = preferences.venues.length > 0 && preferences.types.length > 0;
  const previewResults = config.venues
    .filter((venue) => preferences.venues.includes(venue.code))
    .map((venue) => PREVIEW_RESULTS[venue.code])
    .filter(Boolean)
    .sort((left, right) => right.collectionPaise - left.collectionPaise);
  const notificationPreviews = {
    period_results: {
      label: "Show results",
      title: previewResults.length === 1 ? "Morning show" : "Morning shows",
      body: previewResults.length
        ? previewResults.map((result) => result.line).join("\n")
        : "Select at least one theatre to preview results."
    },
    ...STATIC_PREVIEWS
  };
  const selectedPreview = notificationPreviews[previewType];

  useEffect(() => {
    if (!open || preview) return;
    let active = true;
    Promise.all([
      fetch(`${apiBase}/api/notifications/config`, { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`Notification API returned ${response.status}`);
        return response.json();
      }),
      currentPushSubscription(),
      fetch(`${apiBase}/api/adoption`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null)
    ]).then(([nextConfig, nextSubscription, nextAdoption]) => {
      if (!active) return;
      setConfig(nextConfig);
      setSubscription(nextSubscription);
      setAdoption(nextAdoption);
    }).catch((error) => {
      if (active) setMessage(error.message);
    });
    return () => { active = false; };
  }, [apiBase, open, preview]);

  function toggleAllTheatres() {
    setPreferences((current) => ({
      ...current,
      venues: current.venues.length === config.venues.length
        ? []
        : config.venues.map((venue) => venue.code)
    }));
  }

  function toggleTheatre(code) {
    setPreferences((current) => ({ ...current, venues: toggleValue(current.venues, code) }));
  }

  function toggleType(code) {
    setPreferences((current) => {
      const types = toggleValue(current.types, code);
      return types.length ? { ...current, types } : current;
    });
  }

  async function save() {
    if (!canSave) {
      setMessage(preferences.venues.length ? "Select at least one notification type." : "Select at least one theatre.");
      return;
    }
    setWorking(true);
    setMessage("");
    try {
      if (preview) {
        storeNotificationPreferences(preferences);
        setSubscription({ endpoint: "preview" });
        setMessage(enabled ? "Preview preferences saved locally." : "Notifications are now enabled on this preview.");
      } else if (subscription) {
        await updatePushPreferences(apiBase, subscription, preferences);
        setMessage("Notification preferences saved.");
      } else {
        if (!config.available) throw new Error("Notifications are not configured on the server yet.");
        const nextSubscription = await enablePushNotifications(apiBase, config.publicKey, preferences);
        setSubscription(nextSubscription);
        setMessage("Notifications are now enabled.");
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking(false);
    }
  }

  async function disable() {
    setWorking(true);
    setMessage("");
    try {
      if (!preview) await disablePushNotifications(apiBase, subscription);
      setSubscription(null);
      setMessage("Notifications are turned off on this device.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking(false);
    }
  }

  async function testNotification() {
    setMessage("");
    try {
      if (preview) {
        setMessage(`This is how the ${selectedPreview.label.toLowerCase()} notification will appear.`);
      } else {
        await showTestNotification({
          title: selectedPreview.title,
          body: selectedPreview.body,
          tag: previewType
        });
        setMessage("Test notification sent to this device.");
      }
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <>
      <button
        className={`notification-trigger${enabled ? " is-enabled" : ""}`}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Notification settings"
      >
        <span className="notification-trigger__bell" aria-hidden="true" />
        <span className="notification-trigger__label">Alerts</span>
      </button>

      {open && createPortal((
        <div className="notification-modal" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section className="notification-sheet" role="dialog" aria-modal="true" aria-labelledby="notification-title">
            <header className="notification-sheet__header">
              <div>
                <span className="notification-sheet__eyebrow">MPLTalkies alerts</span>
                <h2 id="notification-title">Notifications</h2>
                <p>Grouped updates from captured show data.</p>
              </div>
              <div className="notification-sheet__header-actions">
                <span className={`notification-state${enabled ? " is-on" : ""}`}>{enabled ? "On" : "Off"}</span>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close notification settings">×</button>
              </div>
            </header>

            <div className="notification-sheet__body">
              {support.requiresInstall && !preview && (
                <div className="notification-info">
                  Add MPLTalkies to your iPhone Home Screen, open the installed app, then enable notifications here.
                </div>
              )}
              {!support.supported && !preview && (
                <div className="notification-info notification-info--error">This browser does not support Web Push notifications.</div>
              )}
              {adoption && (
                <p className="notification-adoption" aria-label="MPLTalkies adoption">
                  <strong>{adoption.installedPwas}</strong> PWA {adoption.installedPwas === 1 ? "install" : "installs"}
                  <span aria-hidden="true">·</span>
                  <strong>{adoption.notificationsEnabled}</strong> {adoption.notificationsEnabled === 1 ? "device has" : "devices have"} alerts enabled
                </p>
              )}

              <section className="notification-settings-group">
                <div className="notification-settings-group__heading">
                  <div><strong>Theatres</strong><span>Results are grouped after the last selected theatre finishes.</span></div>
                </div>
                <div className="notification-theatres">
                  <label className={`notification-theatres__all${allSelected ? " is-selected" : ""}`}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAllTheatres} />
                    <span className="notification-theatre-check" aria-hidden="true">✓</span>
                    <span className="notification-theatre-name">All theatres</span>
                    <small>One combined notification</small>
                  </label>
                  {config.venues.map((venue) => (
                    <label key={venue.code} className={preferences.venues.includes(venue.code) ? "is-selected" : ""}>
                      <input
                        type="checkbox"
                        checked={preferences.venues.includes(venue.code)}
                        onChange={() => toggleTheatre(venue.code)}
                      />
                      <span className="notification-theatre-check" aria-hidden="true">✓</span>
                      <span className="notification-theatre-name">{venue.name}</span>
                    </label>
                  ))}
                </div>
                {!preferences.venues.length && <p className="notification-selection-error">Select at least one theatre.</p>}
              </section>

              <section className="notification-settings-group">
                <div className="notification-settings-group__heading">
                  <div><strong>Notify me about</strong><span>Choose the updates useful to you.</span></div>
                </div>
                <div className="notification-types">
                  {NOTIFICATION_TYPES.map((type) => (
                    <label key={type.code}>
                      <input
                        type="checkbox"
                        checked={preferences.types.includes(type.code)}
                        onChange={() => toggleType(type.code)}
                      />
                      <span className="notification-check" aria-hidden="true">✓</span>
                      <span><strong>{type.title}</strong><small>{type.description}</small></span>
                    </label>
                  ))}
                </div>
              </section>

              <div className="notification-preview-switch" role="group" aria-label="Test notification preview">
                {Object.entries(notificationPreviews).map(([code, item]) => (
                  <button
                    key={code}
                    type="button"
                    className={previewType === code ? "is-selected" : ""}
                    onClick={() => setPreviewType(code)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <section className="notification-preview" aria-label={`${selectedPreview.label} notification preview`}>
                <strong>{selectedPreview.title}</strong>
                <p>{selectedPreview.body}</p>
                <button
                  type="button"
                  onClick={testNotification}
                  disabled={previewType === "period_results" && !previewResults.length}
                >
                  {preview ? "Preview notification" : "Send test notification"}
                </button>
              </section>

              {message && <p className="notification-message" aria-live="polite">{message}</p>}
            </div>

            <footer className="notification-sheet__footer">
              {enabled && <button className="notification-disable" type="button" onClick={disable} disabled={working}>Turn off</button>}
              <button
                className="notification-save"
                type="button"
                onClick={save}
                disabled={working || !canSave || (!support.supported && !preview) || (support.requiresInstall && !preview)}
              >
                {working ? "Saving…" : enabled ? "Save preferences" : "Enable notifications"}
              </button>
            </footer>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
