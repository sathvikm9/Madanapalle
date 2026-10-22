(function attachBookMyShowMainBridge(root) {
  const REQUEST_EVENT = "skct:bms-main-action";
  const REQUEST_ATTRIBUTE = "data-skct-bms-main-request";
  const RESPONSE_ATTRIBUTE = "data-skct-bms-main-response";

  function reactProps(control) {
    if (!control) return null;
    const key = Object.keys(control).find((item) => item.startsWith("__reactProps$"));
    return key ? control[key] : null;
  }

  function syntheticReactEvent(control) {
    return {
      currentTarget: control,
      target: control,
      nativeEvent: { target: control },
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      persist() {}
    };
  }

  function invokeReactClick(control) {
    const handler = reactProps(control)?.onClick;
    if (typeof handler !== "function") return false;
    handler(syntheticReactEvent(control));
    return true;
  }

  function invokeReactChange(control) {
    if (!control) return false;
    const props = reactProps(control) || {};
    const handler = typeof props.onChange === "function"
      ? props.onChange
      : typeof props.onInput === "function"
        ? props.onInput
        : null;
    if (!handler) return false;
    handler(syntheticReactEvent(control));
    return true;
  }

  function nativeClick(control) {
    if (!control) return false;
    const click = root.HTMLElement?.prototype?.click;
    if (typeof click === "function") click.call(control);
    else control.click?.();
    return true;
  }

  function setRangeValue(control, value) {
    if (!control) return false;
    const setter = Object.getOwnPropertyDescriptor(root.HTMLInputElement?.prototype || {}, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  }

  function setSelectValue(control, value, method = "native") {
    if (!control || !value) return false;
    const setter = Object.getOwnPropertyDescriptor(root.HTMLSelectElement?.prototype || {}, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    if (method === "react") return invokeReactChange(control);
    control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  }

  function findButton(documentRef, label) {
    return Array.from(documentRef.querySelectorAll("button")).find((control) => (
      String(control.getAttribute("aria-label") || control.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase() === label.toLowerCase()
    )) || null;
  }

  function activateClick(control, method = "native") {
    return method === "react" ? invokeReactClick(control) : nativeClick(control);
  }

  function performAction(documentRef, request) {
    const details = typeof request === "string" ? { action: request } : (request || {});
    const { action, method = "native", value = "", ariaLabel = "" } = details;
    if (action === "set_quantity_one") {
      const quantityOne = documentRef.querySelector("#quantity-1");
      if (quantityOne) {
        return {
          ok: activateClick(quantityOne, method),
          control: "quantity-1",
          method
        };
      }
      const range = documentRef.querySelector('input[type="range"]');
      return { ok: setRangeValue(range, "1"), control: "quantity-range", method: "value" };
    }

    if (action === "set_select") {
      const control = Array.from(documentRef.querySelectorAll("select")).find((select) => (
        select.getAttribute("aria-label") === ariaLabel
      )) || null;
      return {
        ok: setSelectValue(control, value, method),
        control: ariaLabel || null,
        method,
        value
      };
    }

    const control = action === "select_seats"
      ? findButton(documentRef, "Select Seats")
      : action === "open_accessibility"
        ? documentRef.querySelector('button[aria-label="Open accessibility seat selection"]')
        : null;
    if (!control) return { ok: false, control: null, error: "control_missing" };
    return {
      ok: activateClick(control, method),
      control: action,
      method
    };
  }

  function installBridge(documentRef) {
    documentRef.addEventListener(REQUEST_EVENT, () => {
      let request = {};
      try {
        request = JSON.parse(documentRef.documentElement.getAttribute(REQUEST_ATTRIBUTE) || "{}");
      } catch {
        request = {};
      }
      let response;
      try {
        response = { id: request.id || null, ...performAction(documentRef, request) };
      } catch (error) {
        response = {
          id: request.id || null,
          ok: false,
          error: String(error?.message || error).slice(0, 300)
        };
      }
      documentRef.documentElement.setAttribute(RESPONSE_ATTRIBUTE, JSON.stringify(response));
    });
  }

  root.SKCTBookMyShowMain = {
    REQUEST_EVENT,
    REQUEST_ATTRIBUTE,
    RESPONSE_ATTRIBUTE,
    reactProps,
    invokeReactClick,
    invokeReactChange,
    setRangeValue,
    setSelectValue,
    performAction,
    installBridge
  };

  if (typeof document !== "undefined" && document?.documentElement) installBridge(document);
})(globalThis);
