import React from "react";
import styles from "../Client.module.css";

export interface RuleSectionProps {
  inst: string;
  onChange: (value: string) => void;
  count: number;
}

export default function RuleSection(props: RuleSectionProps): JSX.Element {
  const { inst, onChange, count } = props;

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>ルール</h2>
      <textarea
        className={styles.textarea}
        value={inst}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        placeholder="チャットルールを入力..."
      />
      <div className={styles.counter}>{count} 文字</div>
    </section>
  );
}
