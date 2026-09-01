# dsh-slice-agent-loop

DSH 的切片式 agent loop：不重放 transcript，每轮从账本重建一个有界的工作切片。本表是项目的规范词汇——输出（issue 标题、提案、测试名）用这里的词，不漂移到 _Avoid_ 列的同义词。

## Language

**缓存前缀 (cache prefix)**:
跨轮字节稳定、吃 provider 缓存折扣的上下文头段：kernel + 上一轮结束时的 tape。任何把内容挪出它或在它内部改字节的改动，都是把该内容的计费从缓存价改成全价。
_Avoid_: 静态部分、system 区

**现付文本 (per-turn paid text)**:
缓存前缀之外、每轮按全价计费的输入：tape 头以外的段 header、固定槽、变量内容。省它才省钱；省缓存前缀里的字节几乎不省钱。
_Avoid_: 动态部分、boilerplate

**教学点 (teaching site)**:
一条规则在 slice 里被陈述的位置。设计约束：每条规则恰好一个教学点——机制类归 kernel（缓存价），轮内行为纪律归 NOW 尾（尾部显著性），header 不复述任何一方。
_Avoid_: 重复提醒、reinforcement
