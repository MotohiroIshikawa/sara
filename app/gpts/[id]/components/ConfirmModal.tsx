import React, { type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";
import { type ScheduleDto } from "@/types/schedule";
import { summarizeScheduleJa } from "@/utils/schedule/scheduleValidators";

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  name: string;
  inst: string;
  schedToggle: boolean;
  sched: ScheduleDto | null;
  isPublic?: boolean;
}

export default function ConfirmModal(props: ConfirmModalProps): JSX.Element | null {
  const { open, onClose, onSave, name, inst, schedToggle, sched, isPublic } = props;
  if (!open) return null;

  const visibilityLabel: string | null =
    typeof isPublic === "boolean" ? (isPublic ? "公開" : "非公開") : null;

  return (
    <div className={styles.modal}>
      <section className="mx-auto max-w-screen-sm p-4 space-y-4">
        <div className="text-base font-semibold pt-2">保存内容の確認</div>

        <div className={`${styles.card} shadow-sm`}>
          <div className="text-sm font-medium">名前</div>
          <div className="mt-1 break-words">{name || "(無題)"}</div>

          <div className="mt-4 text-sm font-medium">ルール</div>
          <pre className={styles.codeBlock}>{inst}</pre>
          {visibilityLabel !== null ? (
            <>
              <div className="mt-4 text-sm font-medium">公開設定</div>
              <div className="mt-1 text-sm">{visibilityLabel}</div>
            </>
          ) : null}

          <div className="mt-4 text-sm font-medium">スケジュール</div>
          {schedToggle && sched ? (
            <div className="mt-1 text-sm">
              <div>
                {summarizeScheduleJa(sched)} ・ {sched.enabled ? "実施中" : "停止中"}
              </div>
              {sched.enabled && (
                <div className="mt-1 text-xs text-gray-600">
                  次回実施日時: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : "-"}
                </div>
              )}
            </div>
          ) : (
            <div className="mt-1 text-sm text-gray-600">未登録</div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.footerBtnGray} onClick={onClose}>
            修正する
          </button>
          <button className={styles.footerBtnGreen} onClick={onSave}>
            保存
          </button>
        </div>
      </section>
    </div>
  );
}
