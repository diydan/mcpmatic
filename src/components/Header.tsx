import { useEffect, useId, useState } from "react";

type Props = {
  placeholder: string;
  submitLabel: string;
  onSubmit: (url: string) => void | Promise<void>;
  disabled?: boolean;
  error?: string;
  /**
   * Incremented by the parent when a submit succeeds. Header resets its
   * internal value to "" whenever this prop changes, so the page can drive
   * "clear on success" without exposing an imperative handle.
   */
  successKey?: number | string;
};

export function Header({
  placeholder,
  submitLabel,
  onSubmit,
  disabled,
  error,
  successKey,
}: Props) {
  const [value, setValue] = useState("");
  const inputId = useId();
  // The submit button alone reflects "is there something to submit?".
  // The input stays editable even when empty so the user can type into
  // it — disabling the input while empty makes it unfocusable.
  const inputDisabled = !!disabled;
  const submitDisabled = !!disabled || !value.trim();

  useEffect(() => {
    setValue("");
  }, [successKey]);

  return (
    <header className="header">
      <form
        className="header__form"
        role="search"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const next = value.trim();
          if (!next) return;
          void onSubmit(next);
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {placeholder}
        </label>
        <input
          id={inputId}
          className="header__input"
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          disabled={inputDisabled}
        />
        <button
          type="submit"
          className="primary header__submit"
          disabled={submitDisabled}
        >
          {submitLabel}
        </button>
      </form>
      <p className="header__error" role="alert" hidden={!error}>
        {error}
      </p>
    </header>
  );
}
