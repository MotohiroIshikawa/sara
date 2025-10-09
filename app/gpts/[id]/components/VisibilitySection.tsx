"use client";

import SegmentedSwitch, { type SegmentedSwitchOption } from "@/components/SegmentedSwitch";
import { memo } from "react";

export type VisibilitySectionProps = {
  /** true=公開 / false=非公開 */
  value: boolean;
  /** 変更ハンドラ */
  onChange: (next: boolean) => void;
  /** 追加クラス（任意） */
  className?: string;
};

/**
 * 公開/非公開 切替セクション
 * - 指定の SegmentedSwitch を内部で利用
 * - グループラベル: 「公開設定」
 * - オプション: 「公開」/「非公開」
 */
function VisibilitySectionBase(props: VisibilitySectionProps) {
  const { value, onChange, className = "" } = props;

  const options: [SegmentedSwitchOption, SegmentedSwitchOption] = [
    { value: true, label: "公開", ariaLabel: "公開にする" },
    { value: false, label: "非公開", ariaLabel: "非公開にする" },
  ];

  return (
    <section className={className}>
      <SegmentedSwitch
        className="mt-3"
        value={value}
        onChange={onChange}
        groupLabel="公開設定"
        options={options}
      />
    </section>
  );
}

const VisibilitySection = memo(VisibilitySectionBase);
export default VisibilitySection;
