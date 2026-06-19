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