import React from "react";
import styles from "../Client.module.css";

export default function SkeletonCard(): JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.skelLine1} />
      <div className={styles.skelLine2} />
      <div className={styles.skelBar} />
    </div>
  );
}
