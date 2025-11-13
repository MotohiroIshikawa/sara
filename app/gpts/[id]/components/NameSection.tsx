import React, { type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

interface NameSectionProps {
  name: string;
  onChange: (value: string) => void;
  count: number;
}

export default function NameSection(props: NameSectionProps): JSX.Element {
  const { name, onChange, count } = props;

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>名前</h2>
      <input
        className={styles.inputText}
        value={name}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder="ルールの名前を入力..."
      />
      <div className={styles.counter}>{count} 文字</div>
    </section>
  );
}
