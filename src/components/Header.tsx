import { useId, useState } from "react";

type Props = {
  placeholder: string;
  submitLabel: string;
  onSubmit: (url: string) => void | Promise<void>;
  disabled?: boolean;
  error?: string;
};

export function Header({ placeholder, submitLabel, onSubmit, disabled, error }: Props) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const isDisabled = !!disabled || !value.trim();

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
          disabled={isDisabled}
        />
        <button type="submit" className="primary header__submit" disabled={isDisabled}>
          {submitLabel}
        </button>
      </form>
      <p className="header__error" role="alert" hidden={!error}>
        {error}
      </p>
    </header>
  );
}
