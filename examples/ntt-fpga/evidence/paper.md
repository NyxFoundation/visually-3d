# Evidence: CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA)

## Provenance & access notes

- **Authoritative source:** Xiangren Chen, Bohan Yang, Shouyi Yin, Shaojun Wei, Leibo Liu (Tsinghua University), *"CFNTT: Scalable Radix-2/4 NTT Multiplication Architecture with an Efficient Conflict-free Memory Mapping Scheme,"* IACR Transactions on Cryptographic Hardware and Embedded Systems (TCHES), **Vol. 2022, Issue 1, pp. 94–126**, published **2021-11-19**, DOI `10.46586/tches.v2022.i1.94-126`. License CC BY 4.0. `[paper:metadata]`
- **What was retrievable:** The journal landing/abstract page yielded the **complete verbatim abstract** and metadata (transcribed below). The full PDF (`.../download/9291/8857`, ~1.9 MB) was fetched but its body is FlateDecode-compressed stream data that the fetch tool could not decode to text; the d-nb.info mirror returned the same binary PDF; ResearchGate and IACR eprint mirrors returned **HTTP 403**. The Semantic Scholar API returned only a paraphrased abstract/TLDR.
- **Consequence:** The deep Section III/IV technical content — exact addressing functions, the per-stage crossbar permutation table, twiddle-ROM addressing formula, the radix-4 transform schedule, FSM transition tables, the specific prime, BRAM depth, and the host/PCIe interface — **could not be transcribed from the source text in this pass.** Each blocked PRIORITY item is recorded explicitly under "## Not extractable in this pass" rather than guessed. The verified facts below are from the abstract/metadata, which is authoritative but high-level.

## Verbatim abstract `[paper:abstract]`

> "Number theoretic transform (NTT) is widely utilized to speed up polynomial multiplication, which is the critical computation bottleneck in a lot of cryptographic algorithms like lattice-based post-quantum cryptography (PQC) and homomorphic encryption (HE). One of the tendency for NTT hardware architecture is to support diverse security parameters and meet resource constraints on different computing platforms. Thus flexibility and Area-Time Product (ATP) become two crucial metrics in NTT hardware design. The flexibility of NTT in terms of different vector sizes and moduli can be obtained directly. Whereas the varying strides in memory access of in-place NTT render the design for different radix and number of parallel butterfly units a tough problem. This paper proposes an efficient conflict-free memory mapping scheme that supports the configuration for both multiple parallel butterfly units and arbitrary radix of NTT. Compared to other approaches, this scheme owns broader applicability and facilitates the parallelization of non-radix-2 NTT hardware design. Based on this scheme, we propose a scalable radix-2 and radix-4 NTT multiplication architecture by algorithm-hardware co-design. A dedicated schedule method is leveraged to reduce the number of modular additions/subtractions and modular multiplications in radix-4 butterfly unit by 20% and 33%, respectively. To avoid the bit-reversed cost and save memory footprint in arbitrary radix NTT/INTT, we put forward a general method by rearranging the loop structure and reusing the twiddle factors. The hardware-level optimization is achieved by excavating the symmetric operators in radix-4 butterfly unit, which saves almost 50% hardware resources compared to a straightforward implementation. Through experimental results and theoretical analysis, we point out that the radix-4 NTT with the same number of parallel butterfly units outperforms the radix-2 NTT in terms of area-time performance in the interleaved memory system. This advantage is enlarged when increasing the number of parallel butterfly units. For example, when processing 1024 14-bit points NTT with 8 parallel butterfly units, the ATP of LUT/FF/DSP/BRAM in radix-4 NTT core is approximately 2.2×/1.2×/1.1×/1.9× less than that of the radix-2 NTT core on a similar FPGA platform."

Keywords: number theoretic transform; polynomial multiplication; algorithm-hardware co-design; radix-4; conflict-free memory mapping scheme. `[paper:metadata]`

## Verified facts pinned to PRIORITY items

### parameter "radix" — corrects the impl guess
The abstract states the paper proposes **"a scalable radix-2 and radix-4 NTT multiplication architecture"** and a memory scheme supporting **"arbitrary radix of NTT"** that "facilitates the parallelization of non-radix-2 NTT hardware design." `[paper:abstract]`
→ **Ground truth: radix-4 is a full NTT architecture/schedule, not merely a butterfly unit.** This directly contradicts the impl note "4 only as a butterfly unit, not full schedule." The exact radix-4 schedule equations were not extractable (see below), but the architecture-level existence of a full radix-4 NTT is confirmed by the source.

### param — modulus
The headline example processes **"1024 14-bit points NTT."** `[paper:abstract]`
→ Confirms the source works with a **14-bit NTT-friendly prime** in its headline experiment. The abstract also notes flexibility across **"different vector sizes and moduli."** **The specific prime value (e.g. whether it is 12289) is NOT stated in the retrievable text** — `q=12289` remains a reproduction fix, not source-confirmed.

### Named property — "Conflict-free memory mapping (arbitrary radix / #BU, no bank conflict)"
Confirmed as the paper's central contribution: **"an efficient conflict-free memory mapping scheme that supports the configuration for both multiple parallel butterfly units and arbitrary radix of NTT."** It addresses the problem that **"varying strides in memory access of in-place NTT render the design for different radix and number of parallel butterfly units a tough problem."** Operates in an **"interleaved memory system."** `[paper:abstract]`

### Named property — "No bit-reversal stage / natural-order output"
Confirmed: **"To avoid the bit-reversed cost and save memory footprint in arbitrary radix NTT/INTT, we put forward a general method by rearranging the loop structure and reusing the twiddle factors."** `[paper:abstract]`
→ The bit-reversal elimination and the twiddle-reuse mechanism are achieved together via loop-structure rearrangement. (The explicit twiddle-ROM addressing formula is not in the retrievable text.)

### Named property — "Radix-4: 33% fewer mults / 20% fewer add/sub"
Confirmed exactly, attributed to "a dedicated schedule method": **reduce modular additions/subtractions by 20% and modular multiplications by 33% in the radix-4 butterfly unit.** `[paper:abstract]`

### Named property — "~50% butterfly hardware saved via symmetric operators"
Confirmed: hardware-level optimization "by excavating the symmetric operators in radix-4 butterfly unit … **saves almost 50% hardware resources** compared to a straightforward implementation." `[paper:abstract]`

### Named property — "ATP advantage 2.2×/1.2×/1.1× /1.9× LUT/FF/DSP/BRAM vs radix-2"
Confirmed, with its exact basis: **"when processing 1024 14-bit points NTT with 8 parallel butterfly units, the ATP of LUT/FF/DSP/BRAM in radix-4 NTT core is approximately 2.2×/1.2×/1.1×/1.9× less than that of the radix-2 NTT core on a similar FPGA platform."** `[paper:abstract]`
→ Basis is fully specified: N=1024, 14-bit modulus, 8 parallel BUs, radix-4 core vs radix-2 core, same FPGA platform. (Exact device family/frequency/cycle counts not in retrievable text.)

## Not extractable in this pass (PDF body undecodable; mirrors blocked)

The source unquestionably contains these (they are described in the abstract as core results), but the specific formulas/tables/values are in the compressed PDF body, which could not be rendered to text. These remain **unverified from source** — do not treat any reproduction-invented value as source-confirmed:

- **Conflict-free bank-index and offset functions + per-stage crossbar permutation σ_s** (the Sec. III headline). Existence confirmed; **exact functions and the permutation table NOT transcribed.** The reproduction-chosen XOR-fold routing remains unverified against the paper's actual interleaved-bank topology.
- **Twiddle-ROM addressing f(stage, block)** under the rearranged loop. The *mechanism* ("rearranging the loop structure and reusing the twiddle factors") is confirmed; **the explicit addressing formula NOT transcribed.**
- **Full radix-4 transform schedule** (fused two-stage pass, radix-4 conflict-free addressing). Existence of a full radix-4 architecture confirmed (see "radix" above); **the schedule equations/addressing NOT transcribed.**
- **Radix-4 cycle accounting** (the `bf_cycles_per_stage_r4=32 / total=160` vs 256 BU / 4 lanes = 64 cycles/stage reconciliation): **no cycle-count tables retrievable.**
- **Radix-4 butterfly multiplier count** (3-mult vs 2-mult contradiction): the abstract states a *33% multiplication reduction* via symmetric-operator sharing but **does not give the absolute multiplier count per radix-4 BU** in retrievable text. Unresolved from source.
- **FSM transition table** (`schedule_controller`): **not retrievable.**
- **BRAM depth** (256 vs 128 words/bank inconsistency for `bram_0`): **no specific BRAM depth/bank-size figures retrievable.**
- **PCIe/DMA framing, handshake, beat packing** (`host_phy`): **not mentioned in the abstract; not retrievable.** Likely out of scope of the paper (the paper presents an NTT core, not a host interface) — treat `host_phy` as reproduction-invented unless the PDF body proves otherwise.
- **Exact prime modulus value** and **device/frequency**: not in retrievable text (only "14-bit," "a similar FPGA platform").

## Recommended next action for the loop
To lift the remaining `[source-missing]` ceilings, the PDF needs a real text-extraction path (the FlateDecode streams must be decoded). The blocking is purely a fetch/decoding limitation, not a true source gap — the paper does contain Sec. III mapping functions, the σ permutation, the radix-4 schedule, and resource tables. A successful PDF text extraction of `https://tches.iacr.org/index.php/TCHES/article/download/9291/8857` (or an unblocked eprint/ResearchGate copy) should be attempted next; secondary corroboration is available in citing works (IACR eprint 2026/621 "Efficient Conflict-Free NTT Hardware Architecture" and eprint 2023/1617), which were 403-blocked this pass.

---

## Evidence gathered 20260619-171232 (method: refs; targeting 17 gap(s))

I now have comprehensive ground truth. The paper PDFs are FlateDecode-compressed and not extractable via WebFetch, but the IACR abstract page plus the authors' own reference implementation (`xiang-rc/cfntt_ref`) fill nearly every priority gap. Writing the evidence document.

# Evidence: CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA)

## 0. Provenance & extraction notes

- **Primary source (paper):** Xiangren Chen, Bohan Yang, Shouyi Yin, Shaojun Wei, Leibo Liu (BNRist / Tsinghua University), *"CFNTT: Scalable Radix-2/4 NTT Multiplication Architecture with an Efficient Conflict-free Memory Mapping Scheme,"* IACR TCHES 2022(1), pp. 94–126. DOI `10.46586/tches.v2022.i1.94-126`. `[paper:metadata]`
- The three paper/PDF URLs supplied (TCHES `view/9291`, `download/9291/8857`, the d-nb.info mirror) **all return the PDF as a FlateDecode-compressed binary stream that the fetch tool cannot decode to text**. Only the IACR article landing page (HTML abstract) was machine-readable. So all *paper-body* equations, the exact mapping derivation, the FSM table, and the naive-radix-4 baseline **could not be transcribed from the paper text itself** — see §8 "Not extractable from the source."
- **Authoritative secondary source:** the **authors' own reference implementation** at `https://github.com/xiang-rc/cfntt_ref` (MIT license; Verilog 93% / Python 7%; "tailored for the paper"). This is by the first author (`xiang-rc` = Xiangren Chen), so it is the closest thing to ground truth for the implicit details, but it is still an *implementation* and may differ in constants/encoding from the paper's general formulas. Every fact from it is tagged `[ref-impl:cfntt_ref]` and marked **SECONDARY**.

---

## 1. Abstract-level facts (from the paper landing page) `[paper:abstract]`

Verbatim/near-verbatim claims confirmed from the IACR article page:

- Proposes "an efficient conflict-free memory mapping scheme that supports the configuration for both **multiple parallel butterfly units** and **arbitrary radix** of NTT," with "broader applicability and facilitating the parallelization of non-radix-2 NTT hardware design."
- "A dedicated schedule method is leveraged to reduce the number of **modular additions/subtractions and modular multiplications in radix-4 butterfly unit by 20% and 33%, respectively.**"
- Hardware saving: "excavating the **symmetric operators** in radix-4 butterfly unit, which saves **almost 50% hardware resources**."
- Bit-reversal elimination: "a general method by **rearranging the loop structure and reusing the twiddle factors**" to avoid bit-reversal cost.
- Performance comparison (stated for **N=1024, 14-bit points, 8 parallel units**): "The **ATP of LUT/FF/DSP/BRAM in radix-4 NTT core is approximately 2.2×/1.2×/1.1×/1.9× less** than that of the radix-2 NTT core."
- Target applications: lattice-based PQC and homomorphic encryption.

So **all six named properties in the brief are confirmed by the paper's own abstract**, but the *quantified bases* (the naive-radix-4 "10 add/sub" baseline behind the 20%, the per-state cycle table behind "9 cycles/lane") are **not** in the abstract and were not extractable from the PDF body — see §8.

The reference repo README confirms the case-study parameters: **N = 1024, q = a 14-bit modulus**, synthesized with **Vivado 2020.2** on **Xilinx Virtex-7 `xc7vx690tffg1761-3`**; radix-4 requires N to be a power of 4 (targets Falcon-1024, Dilithium, Saber); radix-2 covers Falcon-512. `[ref-impl:cfntt_ref README]`

---

## 2. The modulus — PRIORITY gap `[ref-impl:cfntt_ref]` SECONDARY

The paper abstract only ever says **"14-bit modulus"**; it does **not** (in any text reachable here) name a specific prime. **However, the authors' reference implementation pins it concretely:**

- `model_code/poly_mult_radix_2.py`: `q = 12289`
- `hardware_code_radix-4/modular_mul.v`: `parameter q = 14'd12289;`

So **q = 12289** (= 3·2¹² + 1, a 14-bit NTT-friendly prime) is **not merely a reproduction guess — it is the value the authors themselves use** in the released code. This *upgrades* the downstream "reproduction fix" to an authors-confirmed (secondary) constant, though the paper body's own stated prime remains unverified from the PDF.

---

## 3. Conflict-free (bank, offset) memory mapping — PRIORITY gap `[ref-impl:cfntt_ref hardware_code_radix-4/conflict_free_memory_map.v]` SECONDARY

**This is the single most important correction to the downstream reproduction.** The mapping is **NOT an XOR-fold.** It is a **digit-sum-modulo-radix** scheme. Verbatim logic (10-bit linear address in, for N=1024, 4 banks, radix-4):

```verilog
// offset within bank = linear address >> 2  (top 8 bits)
assign new_address_0_tmp = old_address_0[9:2];   // 8-bit bank offset

// bank index = (sum of the five 2-bit digits of the address) mod 4
assign bank_number_0_tmp = old_address_0[9:8] + old_address_0[7:6]
                         + old_address_0[5:4] + old_address_0[3:2]
                         + old_address_0[1:0];    // captured into a 2-bit DFF ⇒ mod 4
```

So, writing the 10-bit address `a` as radix-4 digits `a = (d4 d3 d2 d1 d0)` (each `d_i` = 2 bits):

- **bank(a) = (d0 + d1 + d2 + d3 + d4) mod 4**  (the 5-digit base-4 digit sum, truncated to 2 bits)
- **offset(a) = a >> 2 = (d4 d3 d2 d1)**  (drop the least-significant base-4 digit; the 8 high bits)

There are **4 banks** (`bank_number` is `[1:0]`) and **256 entries/bank** (`new_address` is `[7:0]`) → 1024 total, matching N. Both outputs are registered through `DFF` (1-cycle).

This digit-sum-mod-radix mapping is exactly the kind of construction that guarantees the four operands of any radix-4 butterfly at every stage land in four *distinct* banks (no conflict), for arbitrary radix / #BU — which is the paper's headline claim. **The reproduction's "guessed XOR-fold" is structurally wrong; replace it with this additive digit-sum-mod-4 function.**

### 3.1 The natural (pre-remap) address generation `[ref-impl:cfntt_ref hardware_code_radix-4/address_generator.v]` SECONDARY

`address_generator.v` produces the four *linear* operand addresses for a radix-4 butterfly from stage `p` (0..4), block counter `k` (8-bit), inner counter `j` (8-bit), **before** the conflict-free remap:

```verilog
// operand 0 base address
assign old_address_0 = ((k << 2) << (p << 1)) + j;
```

Operands 1, 2, 3 are formed by **inserting fixed bits (`1'b1`, `1'b1`, `2'b11`) at stage-`p`-dependent bit positions** of `old_address_0`, e.g. for `p==4` (`3'b100`):

```verilog
old_address_1 = {old_address_0[9],   1'b1, old_address_0[7:0]};
old_address_2 = {                    1'b1, old_address_0[8:0]};
old_address_3 = {                    2'b11, old_address_0[7:0]};
```

i.e. the four operands of a radix-4 group differ in the **two bits at stride position `2p`** — the standard radix-4 in-place stride. The pipeline is therefore: **`address_generator` (natural strided addresses) → `conflict_free_memory_map` (bank = digit-sum mod 4, offset = addr≫2) → banked BRAM.** The crossbars that physically route 4 banks ↔ 4 butterfly lanes per the bank indices are separate modules: `network_bank_in.v`, `network_bf_in.v`, `network_bf_out.v` (these realize the per-stage permutation σ_s; their internals were not transcribed). `[ref-impl:cfntt_ref]`

---

## 4. Twiddle-ROM addressing f(stage, block) — PRIORITY gap `[ref-impl:cfntt_ref hardware_code_radix-4/tf_address_generator.v]` SECONDARY

The twiddle address is a function of stage `p` (0..4) and block counter `k`, with **separate offset tables for NTT and INTT** selected by `conf`:

```verilog
case(p)              // NTT mode (tf_address_reg_0)   |  INTT mode (tf_address_reg_1)
4: tf_address_reg_0 = k;       tf_address_reg_1 = k;
3: tf_address_reg_0 = k + 1;   tf_address_reg_1 = 4   - k;
2: tf_address_reg_0 = k + 5;   tf_address_reg_1 = 20  - k;
1: tf_address_reg_0 = k + 21;  tf_address_reg_1 = 84  - k;
0: tf_address_reg_0 = k + 85;  tf_address_reg_1 = 340 - k;
endcase
```

The **NTT base offsets are cumulative powers of 4**: `0, 1, 5, 21, 85` = running sum of `1, 4, 16, 64` (i.e. offset(p) = (4^(4−p) − 1)/3). This is the **"rearranged twiddle-reuse" layout**: at each stage there are `4^(4−p)` distinct twiddle blocks, one ROM word fetched per `(stage, block)` and **reused across all `j` in that block** — so the ROM holds one entry per block rather than one per butterfly, which is the memory-footprint/reuse optimization the paper claims. The reproduction's "generic bit-reversed ROM, one twiddle per butterfly" is structurally different; the real layout is this stage-segmented, block-indexed table. The INTT mirror (`4−k`, `20−k`, `84−k`, `340−k`) reads the same segments in reverse, supporting bit-reversal-free INTT. The output `tf_address` is `[8:0]` (≤512 entries) and registered (1-cycle DFF). `[ref-impl:cfntt_ref]`

---

## 5. Control FSM — PRIORITY gap `[ref-impl:cfntt_ref hardware_code_radix-4/fsm.v]` SECONDARY

**6 states, 3-bit encoded:**

| State | Encoding |
|---|---|
| `IDLE` | `3'b000` |
| `NTT` | `3'b001` |
| `PWM` (point-wise mult) | `3'b010` |
| `INTT` | `3'b011` |
| `DONE_NTT` | `3'b100` |
| `DONE_INTT` | `3'b101` |

**Transition / completion conditions (verbatim semantics):**
- `NTT` done when `(p_reg == 0) && (k_reg == 255) && (j_reg == 0)` → `done_reg = 4'b0001`. NTT sweeps stages **p = 4 → 0** (decreasing).
- `PWM` done on the same counter condition → `done_reg = 4'b0010`.
- `INTT` done when `(p_reg == 4) && (k_reg == 0) && (j_reg == 255)` → `done_reg = 4'b0100`. INTT sweeps stages **p = 0 → 4** (increasing).

**Loop-counter bounds (per stage p):**
- inner-counter limit: `j_max = (1 << (p<<1)) - 1`  → `(4^p − 1)`
- block-counter limit: `k_max = (256 >> (p<<1)) - 1` → `(256/4^p − 1)` (so `j_max · k_max` covers the 256 radix-4 groups per stage)

**Pipeline / latency constants (the part the brief flags as only an "aggregate 9 cycles/lane"):** the FSM aligns write-back and enables with cascaded shift registers:
- `shift_14` — **14-stage** shift register delaying write-enable
- `shift_13` — **13-stage** shift register delaying the enable signal
- plus 1-stage DFFs on `ren` and `sel`.

⚠️ **Discrepancy worth flagging downstream:** the reference design's read→compute→write-back latency is therefore **~13–14 cycles per lane**, *not* 9. The "9 cycles (mult 3 + add/sub 1 + Barrett 4 + reg 1)" breakdown in the brief is **not corroborated by this code** and was **not** extractable from the paper PDF; treat "9" as unverified. (The Barrett multiplier alone is ~6 pipeline registers — see §6 — and the address-gen + conflict-free remap + BRAM read + crossbar add several more, consistent with 13–14.)

---

## 6. Datapath: Barrett modular multiply & butterfly `[ref-impl:cfntt_ref]` SECONDARY

### 6.1 Modular multiplier `hardware_code_radix-4/modular_mul.v` (module internally named `barret_modular_mul`, "Create Date 2021/05/04")

Reduction is **Barrett**, not Montgomery. Parameters and pipeline (verbatim constants):

```verilog
parameter q0 = 15'h5553;     // Barrett constant μ = 0x5553 = 21843
parameter q  = 14'd12289;    // modulus
// data_width = 14
z         = A_in * B_in;            // 28-bit product            (DFF d1)
z_shift   = z_q1 >> (data_width-1); // >> 13                      (regs d2,d3 carry z)
mul2      = z_shift * q0;           //                           (DFF d5)
mul2_shift= mul2_q >> (data_width+1)// >> 15
mul3      = mul2_shift * q;         //                           (DFF d6)
sub       = z_q3 - mul3_q;
{sign,sub_correct} = sub_low - q;   // single conditional subtract
P_d       = sign ? sub_low : sub_correct;   // final result      (DFF d7)
```

- Barrett shifts: **≫13 then ≫15**; constant **μ = 21843 (0x5553)**; one final conditional subtraction of q (no second correction).
- **Pipeline depth ≈ 6 registers** (d1, d2, d3, d5, d6, d7). This is the "modular multiplication" leg; it does **not** decompose as the brief's "mult 3 + Barrett 4" — it is a single fused 6-stage Barrett multiplier.

### 6.2 Butterfly `hardware_code_radix-4/compact_bf.v` SECONDARY

`compact_bf.v` instantiates **four processing elements `PE0..PE3`** (data_width = 14) cross-coupled with `sel`-multiplexed inputs/outputs (a radix-4 butterfly built from 4 PEs sharing operators — the "symmetric operator excavation" that the abstract credits with ~50% hardware saving). The individual `PE0–PE3.v`, `modular_add.v`, `modular_substraction.v`, `modular_half.v` (the `op21`/÷2 in hardware) hold the operator-sharing detail; their internals were not transcribed here. The radix-4 model's exact 33%-fewer-mult schedule is realized inside these PEs.

### 6.3 Radix-2 reference butterfly & bit-reversal handling `model_code/poly_mult_radix_2.py` SECONDARY

```python
q = 12289
# forward: DIT, natural-order  (DIT_NR_NTT)
u = a[k*2*J+j] % q
t = (a[k*2*J+j+J] * w) % q
a[k*2*J+j]   = (u + t) % q
a[k*2*J+j+J] = (u - t) % q
w = w_rom[r]            # one twiddle per block, incremented r per (stage,block)
# loop: for p in range(log_n-1,-1,-1): J=2**p; for k in range(n//(2*J)): w=w_rom[r]; r+=1; for j in range(J): ...
# inverse: DIF, reversed-order (DIF_RN_INTT) with op21 = exact division by 2 mod q:
def op21(a):
    return (a>>1)%q if (a&1)==0 else ((a>>1)+((q+1)>>1))%q
```

**Bit-reversal-free claim (PRIORITY gap):** the forward transform is **DIT** and the inverse is **DIF** (functions `DIT_NR_NTT` and `DIF_RN_INTT`). Pairing a Cooley-Tukey (DIT) forward with a Gentleman-Sande (DIF) inverse means the bit-reversal permutation of the forward is *absorbed* by the inverse — point-wise multiply happens in the scrambled domain and the final result returns in natural order **with no explicit bit-reversal/relabel stage in hardware**. The twiddle reuse (`w = w_rom[r]; r += 1` once per `(stage, block)`, reused across all `j`) is visible in the loop structure and matches §4. This corroborates "natural-order output / no bit-reversal stage" **structurally** (it's algorithmic, via DIT+DIF pairing — not a post-hoc relabel).

---

## 7. Reference-implementation file map (for the downstream tool to cite) `[ref-impl:cfntt_ref]`

Repo: **https://github.com/xiang-rc/cfntt_ref** (39★, MIT). Relevant files for the implicit gaps:

- `hardware_code_radix-4/conflict_free_memory_map.v` → **bank/offset mapping** (§3)
- `hardware_code_radix-4/address_generator.v` → **natural strided addresses** (§3.1)
- `hardware_code_radix-4/network_bank_in.v`, `network_bf_in.v`, `network_bf_out.v` → **crossbars / σ_s permutation** (internals not transcribed)
- `hardware_code_radix-4/tf_address_generator.v`, `tf_ROM.v`, `w_ROM.txt` → **twiddle addressing & reuse** (§4)
- `hardware_code_radix-4/fsm.v` → **FSM states/transitions/latency** (§5)
- `hardware_code_radix-4/modular_mul.v` → **Barrett multiply** (§6.1); also `modular_add.v`, `modular_substraction.v`, `modular_half.v`
- `hardware_code_radix-4/compact_bf.v`, `PE0..PE3.v`, `arbiter.v`, `data_bank.v`, `bank0..3.txt`, `common_lib.v`, `tb_top.v`
- `hardware_code_radix-2/` → radix-2 kernel counterpart
- `model_code/poly_mult_radix_2.py` → **functional model, q=12289, DIT/DIF** (§6.3). (No `poly_mult_radix_4.py` is present — the radix-4 functional model is absent; only the radix-2 Python model exists.)
- `resource_table_ref/` → Excel resource tables: `Table_radix2_{1,2,4,8}d.xlsx`, `Table_radix4_{1,2}d_II.xlsx` (per-BFU-count LUT/FF/DSP/BRAM breakdowns; **cell contents not machine-readable via fetch** — they are the basis for the §1 ATP 2.2×/1.2×/1.1×/1.9× claim).

---

## 8. Not extractable / not stated in the reachable source

These were specifically hunted but could not be transcribed (the three paper PDFs are FlateDecode-compressed binary and did not yield text; the abstract page omits them):

- **Paper-body exact (bank, offset) formula and the per-stage crossbar permutation σ_s as written in Sec. III.** Corroborated only structurally via the authors' Verilog (§3) — the *paper's own* general-radix formula/proof text was not captured.
- **Paper's literal statement of the 14-bit prime.** Abstract says only "14-bit modulus"; **q = 12289 comes from the reference code, not from any paper text reached here** (§2).
- **Exact FSM transition table and per-state cycle latencies in the paper.** Only the ref-impl's 6-state machine and 13/14-stage shift delays are available (§5); the paper's "9 cycles/lane" figure was **not** found and the ref-impl appears to contradict it.
- **The naive-radix-4 add/sub baseline (the assumed "10") that pins the 20% reduction.** The paper abstract states the 20%/33% reductions but the *baseline operand counts* are in the (unreadable) body; not found.
- **PCIe/DMA host framing, beat packing, handshake.** **Nothing in the paper or the reference repo describes a PCIe/DMA host interface** — the repo is a standalone NTT/INTT kernel with a `tb_top.v` testbench only. This port/interface is genuinely **reproduction-invented**; the source provides no ground truth for it.
- **Quantitative resource tables (LUT/FF/DSP/BRAM per BFU count)** exist as `.xlsx` files in `resource_table_ref/` but their numeric cells were not machine-readable here; only the abstract's aggregate ATP ratios (2.2×/1.2×/1.1×/1.9×) are confirmed.
- **Internal PE/crossbar logic** (`PE0–PE3.v`, `network_*`) — exist and are the locus of the "~50% symmetric-operator" saving and σ_s permutation, but their internals were not transcribed in this pass.

Sources:
- [CFNTT — IACR TCHES 2022 article page](https://tches.iacr.org/index.php/TCHES/article/view/9291)
- [DOI 10.46586/tches.v2022.i1.94-126](https://doi.org/10.46586/tches.v2022.i1.94-126)
- [xiang-rc/cfntt_ref — authors' reference implementation](https://github.com/xiang-rc/cfntt_ref)
