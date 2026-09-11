# Daily Runeterra Case

> Historical requirements inspiration only. This is not an approved content pack or the current implementation specification. See [original-content policy](content-policy.md) and [authoritative game rules](architecture/game-rules.md). Exclude this document from runtime fixtures, browser bundles and public demo assets.

Một daily detective lore game dựa trên vũ trụ Liên Minh Huyền Thoại. Mỗi ngày người chơi nhận cùng một case, sử dụng kiến thức về champion, region, faction, historical events và các mối liên hệ trong Runeterra để giải.

Mục tiêu là một game **nhanh, đơn giản, chơi khoảng 5–10 phút/ngày**, nhưng đủ khó để fan lore cảm thấy được thử thách và đồng thời giúp newbie dần học lore.

# Core Gameplay

- Mỗi ngày có 1 daily case mới.
- Case sẽ có nhiều dạng:
    - **WHO?** — Champion/person nào liên quan?
    - **WHERE?** — Sự kiện xảy ra ở đâu?
    - **WHAT?** — Artifact/object/event nào?
    - **WHICH FACTION?** — Tổ chức/faction nào đứng sau?
    - **WHAT HAPPENED?** — Sự kiện lịch sử nào?
    - Các case đặc biệt có thể yêu cầu tìm connection giữa nhiều nhân vật/sự kiện.
- **VÍ DỤ:**

> 
> 
> 
> **CASE #042 — The Broken Blade (Case Briefing)**
> 
> Một thi thể được phát hiện gần một ngôi làng ở Ionia. Nạn nhân từng phục vụ trong quân đội Noxus.
> 
> Điều kỳ lạ là vết thương gây tử vong dường như được tạo ra bởi **một kỹ thuật gió**, nhưng không có dấu hiệu cho thấy một kiếm sĩ Ionian đã xuất hiện tại hiện trường.
> 
> **Ai có liên quan đến cái chết này?**
> 
> Ngay ở đây, người biết lore sâu đã có một đường reasoning: Noxian + Ionia + Wind Technique + Not an Ionia Swordman → Riven. (Nếu họ biết chuyện **Riven – Elder Souma – Yasuo**, họ có cơ sở để nghi Riven. Không phải kiểu:
> 
> “Ờ... Ionia... Yasuo?”
> 
- **Case Briefing phải chứa đủ thông tin để solve.**
- Sau khi player không có idea gì về câu trả lời cho Case Briefing thì có thể chọn Guess hoặc Reveal Evidence.
- Case Briefing được tính là **0 evidence used**.
- Ở mỗi evidence level, player được guess tối đa **3 lần**. Sau lần guess sai thứ ba, evidence tiếp theo được mở. Player vẫn có thể chủ động reveal evidence tiếp theo trước khi sử dụng hết ba lượt guess.

# Answer Input & Suggestions

- Game không dùng fuzzy matching để tự động chấp nhận typo hoặc một đáp án gần đúng.
- Ô nhập đáp án sử dụng autocomplete/dropdown theo đúng loại case:
    - **WHO?** — Gợi ý champion/person.
    - **WHERE?** — Gợi ý location/region.
    - **WHAT?** — Gợi ý artifact/object.
    - **WHICH FACTION?** — Gợi ý faction/organization.
    - **WHAT HAPPENED?** — Gợi ý historical event.
- Ví dụ: với case **WHO?**, khi player nhập `Y`, dropdown có thể gợi ý `Yasuo`. Case **WHERE?** chỉ gợi ý địa điểm thay vì tên champion.
- Nếu nội dung player nhập match chính xác một đáp án canonical thì có thể submit ngay, không bắt buộc chọn lại từ dropdown.
- Sau khi player chọn suggestion hoặc nhập chính xác canonical answer, hệ thống chấm bằng entity ID. Tên hiển thị và localization không phải là căn cứ duy nhất để chấm đáp án.

# Progressive Evidence

- Progressive evidence không nên hoạt động như:
    
    > Clue #1 = gần như không biết gì
    > 
    > 
    > Clue #2 = thêm tí
    > 
    > Clue #3 = bắt đầu đoán được
    > 
    > Clue #4 = dễ
    > 
    > Clue #5 = answer
    > 
- Mà nên là:
    
    > **Case Briefing = mystery hoàn chỉnh.**
    > 
    > 
    > Evidence = trợ giúp khi bạn chưa connect được dots.
    > 
    
    Tức là ngay màn đầu tiên player đã nhận được một mini mystery:
    
    > Một Noxian veteran chết tại Ionia. Vết thương giống một kỹ thuật gió của Ionia, nhưng investigators xác định nó xuất phát từ một foreign runic weapon. Vũ khí đó dường như đã bị phá hủy từ rất lâu.
    > 
    > 
    > **Which champion is most closely connected to these clues?**
    > 
    
    Player giỏi lore:
    
    > Wait... Riven?
    > 
    
    **Submit → LEGENDARY.**
    
    Người không biết:
    
    > No idea.
    > 
    
    → `Examine Evidence`
    
    Sau đó game **break down những thông tin đã có hoặc cung cấp evidence bổ sung**.
    
- Một case khó phải khiến người không biết lore nghĩ:
    
    > *“Tôi không biết connection này.”*
    > 
    
    chứ không phải:
    
    > *“Thông tin này thì bố ai mà đoán được.”*
    > 

# Wrong Guess

- Game có thể phản hồi dựa trên relationship:
    
    > 
    > 
    > 
    > NOT QUITE.
    > 
    > Yasuo is connected to this incident,
    > but he isn't the person we're looking for.
    > 
    > New evidence unlocked.
    > 
- Mỗi lần guess sai bị trừ **40 điểm**.
- Một đáp án sai không tự động reveal evidence tiếp theo, trừ khi đó là lần guess sai thứ ba tại evidence level hiện tại.
- Player có thể chủ động reveal evidence tiếp theo bất cứ lúc nào.

# Knowledge > Grinding

- Thứ quyết định performance là **kiến thức lore của người chơi**.

> 🟨 COLD CASE SOLVE
Solved from Case Briefing
1200 pts
> 

> 🟪 LOREMASTER
Solved after Evidence #1
1000 pts
> 

> 🟦 INVESTIGATOR
Solved after Evidence #2
750 pts
> 

> 🟩 DETECTIVE
Solved after Evidence #3
500 pts
> 

> ⬜ CASE CLOSED
Solved after Evidence #4
250 pts
> 

## Scoring Formula

```text
finalScore = max(0, tierScore - 40 × wrongGuesses + timeBonus)
```

| Evidence used | Rank | Tier score |
| ---: | --- | ---: |
| 0 | Cold Case Solve | 1200 |
| 1 | Loremaster | 1000 |
| 2 | Investigator | 750 |
| 3 | Detective | 500 |
| 4 | Case Closed | 250 |

Time bonus được tính từ lúc Case Briefing bắt đầu hiển thị đến khi player submit đáp án đúng:

| Completion time | Time bonus |
| --- | ---: |
| ≤ 30 giây | +150 |
| ≤ 60 giây | +100 |
| ≤ 2 phút | +60 |
| ≤ 5 phút | +25 |
| > 5 phút | 0 |

- **First-Clue Solve** chỉ được ghi nhận nếu player reveal Evidence #1 rồi mới solve. Solve trực tiếp từ Case Briefing không được tính là First-Clue Solve.
- **Give Up** được tính là failed case và nhận 0 điểm.

# Case File Unsealed

- Đáp án được reveal ngay sau khi player solve hoặc Give Up.
- Sau đó mở **CASE FILE UNSEALED:**
    - Game giải thích ngắn gọn **lore đằng sau case**, không chỉ đưa ra answer.
    - Quan trọng hơn nữa là giải thích **từng evidence.**

# Lore Rabbit Hole

- Cuối Case File chỉ đưa ra một vài related topics:

> 
> 
> 
> WANT TO INVESTIGATE FURTHER?
> 
> Riven
> "The Exile"
> 
> Confessions of a Broken Blade
> Related Story
> 
> Noxian Invasion of Ionia
> Historical Event
> 
- Player muốn tìm hiểu thì đọc tiếp; không muốn thì kết thúc Daily Case.
- Ưu tiên link tới lore/content chính thức của League of Legends khi có nguồn phù hợp.

# Daily Streak & Lore Profile

- Gamification chính sẽ rất nhẹ:
    
    > 
    > 
    > 
    > 17 DAY STREAK
    > 
    > Cases Solved        38
    > Cases Failed         4
    > First-Clue Solves   11
    > Accuracy            84%
    > 
- Streak là chuỗi ngày **tham gia Daily Case**. Một ngày được tính là đã tham gia khi player submit ít nhất một guess.
- Give Up không làm đứt streak nếu player đã có ít nhất một guess trong ngày đó. Không tham gia case trong ngày mới làm đứt streak.
- Game theo dõi performance theo Region:
    
    > 
    > 
    > 
    > YOUR RUNETERRA KNOWLEDGE
    > 
    > Demacia       █████████░ 91%
    > Noxus         ███████░░░ 74%
    > Ionia         ████████░░ 82%
    > Shurima       █████░░░░░ 53%
    > Freljord      ████░░░░░░ 41%
    > Bilgewater    ███████░░░ 76%
    > Void          ██████░░░░ 65%
    > 

## Regional Knowledge Formula

Mỗi case được gắn với một hoặc nhiều region. Kết quả của case tạo ra một `performance` score cho từng region liên quan:

| Result | Base performance |
| --- | ---: |
| Solved from Case Briefing | 1.00 |
| Solved after Evidence #1 | 0.85 |
| Solved after Evidence #2 | 0.65 |
| Solved after Evidence #3 | 0.45 |
| Solved after Evidence #4 | 0.25 |
| Failed / Give Up | 0.00 |

```text
performance = max(0, basePerformance - 0.05 × wrongGuesses)
```

Knowledge của từng region dùng Bayesian average với prior ban đầu là `alpha = 2`, `beta = 2`, tương đương mức khởi đầu 50%:

```text
alpha = alpha + performance
beta = beta + (1 - performance)
regionKnowledge = round(100 × alpha / (alpha + beta))
```

Cách tính này giúp vài case đầu không làm knowledge score nhảy ngay về 0% hoặc 100%, đồng thời giảm lợi ích của việc grinding các case dễ.

# Daily Leaderboard

- Tất cả player chơi **cùng một case**, nên có thể compare trực tiếp.
- Ranking dựa trên:
    - **Evidence used → Wrong guesses → Time**
- Đây là thứ tự sort độc lập với `finalScore`: ít evidence hơn luôn xếp trước, sau đó đến ít wrong guesses hơn, cuối cùng mới so completion time.
    
    > 
    > 
    > 
    > CASE #042 — TODAY
    > 
    > 🥇 VoidEnjoyer    0/4   0 wrong   00:18
    > 🥈 JhinFour       0/4   0 wrong   00:31
    > 🥉 Dat            1/4   0 wrong   00:42
    >
