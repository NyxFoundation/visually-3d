// =====================================================================
// CFNTT : Scalable Radix-2/4 NTT Multiplication Accelerator (FPGA)
// Reverse-implemented from a scene-descriptor spec ONLY.
// Target: synthesizable Verilog-2001.
//
// Block correspondence to spec parts:
//   bram_0..7              -> ntt_bram (8 interleaved banks)
//   input_fifo/output_fifo -> ntt_fifo
//   crossbar_network       -> ntt_crossbar (8x4 conflict-free permute)
//   bu_mult/add/sub/reg    -> butterfly_unit (x4 parallel clusters)
//   mod_red_mult/subshift  -> barrett_reduce (shared)
//   intt_scale             -> ninv_scale
//   twiddle_rom            -> twiddle_rom
//   addr_gen_unit          -> addr_gen
//   config_radix_selector  -> config register
//   schedule_controller    -> ntt_fsm
//   clock_pll              -> external (modeled as input clk)
//   heatsink_*             -> physical only, no logic
// =====================================================================

// ---------------------------------------------------------------------
// Shared Barrett modular reduction.
// Spec splits it in two members: (1) q-multiplier estimating the
// quotient floor(x*mu/2^K), (2) shift/subtract + conditional correction.
// Implemented combinationally here; pipeline regs live in the caller.
// ---------------------------------------------------------------------
module barrett_reduce #(
    parameter integer Q     = 12289,   // GUESS: 14-bit NTT prime 12*1024+1
    parameter integer WIDTH = 14,      // coefficient width
    parameter integer K     = 28       // GUESS: Barrett shift = 2*WIDTH
) (
    input  wire [2*WIDTH-1:0] x,        // un-reduced product (<= (Q-1)^2)
    output wire [WIDTH-1:0]   y         // x mod Q in [0,Q)
);
    // mu = floor(2^K / Q), precomputed constant.
    localparam [WIDTH+1:0] MU = (1 << K) / Q;

    // member 1: quotient estimate q_hat = floor(x*mu / 2^K)
    wire [2*WIDTH+WIDTH+1:0] xmu = x * MU;
    wire [2*WIDTH-1:0]       qhat = xmu >> K;

    // member 2: shift/subtract then conditional correction (<=2 subs)
    wire [2*WIDTH-1:0] r0 = x - qhat * Q;
    wire [2*WIDTH-1:0] r1 = (r0 >= Q)     ? (r0 - Q)     : r0;
    wire [2*WIDTH-1:0] r2 = (r1 >= Q)     ? (r1 - Q)     : r1;
    assign y = r2[WIDTH-1:0];
endmodule

// ---------------------------------------------------------------------
// One butterfly cluster: DSP modular multiplier -> symmetric mod add/sub
//                        -> shared Barrett reduction -> pipeline register.
// Radix-2 Cooley-Tukey (DIT) butterfly:
//   t   = b * w        (mod q)   <- DSP mult + shared reduction
//   a'  = a + t        (mod q)   <- symmetric adder
//   b'  = a - t        (mod q)   <- symmetric subtractor (shared operands)
// GUESS: radix-4 reuses this primitive across the FSM schedule rather
//        than instantiating a wider native radix-4 datapath.
// ---------------------------------------------------------------------
module butterfly_unit #(
    parameter integer Q     = 12289,
    parameter integer WIDTH = 14
) (
    input  wire                clk,
    input  wire                rst_n,
    input  wire                en,
    input  wire [WIDTH-1:0]    a_in,
    input  wire [WIDTH-1:0]    b_in,
    input  wire [WIDTH-1:0]    w_in,     // twiddle from ROM (broadcast)
    output reg  [WIDTH-1:0]    a_out,    // pipeline register output
    output reg  [WIDTH-1:0]    b_out,
    output reg                 valid
);
    // DSP modular multiplier (full product) + shared reduction
    wire [2*WIDTH-1:0] prod = b_in * w_in;
    wire [WIDTH-1:0]   t;
    barrett_reduce #(.Q(Q), .WIDTH(WIDTH)) u_red (.x(prod), .y(t));

    // symmetric modular add / sub sharing the operands {a_in, t}
    wire [WIDTH:0] sum  = a_in + t;
    wire [WIDTH:0] diff = a_in + Q - t;            // avoid underflow
    wire [WIDTH-1:0] add_r = (sum  >= Q) ? (sum  - Q) : sum;
    wire [WIDTH-1:0] sub_r = (diff >= Q) ? (diff - Q) : diff;

    // pipeline register (1 stage)
    always @(posedge clk) begin
        if (!rst_n) begin
            a_out <= {WIDTH{1'b0}};
            b_out <= {WIDTH{1'b0}};
            valid <= 1'b0;
        end else begin
            valid <= en;
            if (en) begin
                a_out <= add_r;
                b_out <= sub_r;
            end
        end
    end
endmodule

// ---------------------------------------------------------------------
// INTT N^-1 scaling: multiply each coefficient by N^-1 mod q.
// ---------------------------------------------------------------------
module ninv_scale #(
    parameter integer Q     = 12289,
    parameter integer WIDTH = 14,
    parameter integer NINV  = 12277     // GUESS: 1024^-1 mod 12289
) (
    input  wire [WIDTH-1:0] x,
    output wire [WIDTH-1:0] y
);
    wire [2*WIDTH-1:0] prod = x * NINV;
    barrett_reduce #(.Q(Q), .WIDTH(WIDTH)) u_red (.x(prod), .y(y));
endmodule

// ---------------------------------------------------------------------
// Twiddle-factor ROM. Precomputed roots of unity, one fetch broadcast
// to all multipliers. Contents loaded by $readmemh (GUESS on file/format).
// ---------------------------------------------------------------------
module twiddle_rom #(
    parameter integer WIDTH = 14,
    parameter integer DEPTH = 512,             // GUESS: N/2 forward roots
    parameter integer AWIDTH = 9
) (
    input  wire              clk,
    input  wire [AWIDTH-1:0] addr,
    output reg  [WIDTH-1:0]  w
);
    reg [WIDTH-1:0] mem [0:DEPTH-1];
    initial $readmemh("twiddle.hex", mem);     // GUESS: external init
    always @(posedge clk) w <= mem[addr];
endmodule

// ---------------------------------------------------------------------
// Conflict-free address generation. Produces per-bank read/write
// addresses + the 8x4 crossbar select so the P parallel butterflies
// never collide. The exact mapping equation is NOT in the spec.
// GUESS: stride-permutation mapping bank = (idx + stage*P) mod 8.
// ---------------------------------------------------------------------
module addr_gen #(
    parameter integer N     = 1024,
    parameter integer BANKS = 8,
    parameter integer P     = 4,
    parameter integer AWIDTH= 8,        // ceil(log2(N/BANKS))
    parameter integer SWIDTH= 4,        // ceil(log2(log2(N)))
    parameter integer TWIDTH= 9
) (
    input  wire                       clk,
    input  wire                       rst_n,
    input  wire                       run,
    input  wire                       radix4,     // from config selector
    input  wire [SWIDTH-1:0]          stage,
    input  wire [AWIDTH-1:0]          step,        // butterfly group index
    output wire [P*$clog2(BANKS)-1:0] bank_sel_a,  // bank per lane (operand a)
    output wire [P*$clog2(BANKS)-1:0] bank_sel_b,  // bank per lane (operand b)
    output wire [P*AWIDTH-1:0]        rd_addr,     // intra-bank addr per lane
    output wire [TWIDTH-1:0]          tw_addr      // shared twiddle address
);
    genvar i;
    generate
        for (i = 0; i < P; i = i + 1) begin : g_lane
            // GUESS: linear conflict-free interleave; real CFNTT mapping
            // is a more elaborate bit-rotation derived in the paper.
            assign bank_sel_a[i*3 +: 3] = (step + i)          % BANKS;
            assign bank_sel_b[i*3 +: 3] = (step + i + (BANKS>>1)) % BANKS;
            assign rd_addr[i*AWIDTH +: AWIDTH] = step;
        end
    endgenerate
    // GUESS: twiddle reuse across the rearranged loop -> address = stage|step
    assign tw_addr = {stage, step[TWIDTH-SWIDTH-1:0]};
endmodule

// ---------------------------------------------------------------------
// Schedule / FSM controller. Sequences the conflict-free rearranged
// loop (stages x steps). Cycle counts / latencies are GUESSED.
// ---------------------------------------------------------------------
module ntt_fsm #(
    parameter integer N      = 1024,
    parameter integer P      = 4,
    parameter integer STAGES = 10,      // log2(1024)
    parameter integer SWIDTH = 4,
    parameter integer AWIDTH = 8
) (
    input  wire              clk,
    input  wire              rst_n,
    input  wire              start,
    input  wire              radix4,    // config: stages halved when set
    output reg               busy,
    output reg               done,
    output reg               run,
    output reg  [SWIDTH-1:0] stage,
    output reg  [AWIDTH-1:0] step
);
    localparam S_IDLE = 2'd0, S_LOAD = 2'd1, S_RUN = 2'd2, S_DRAIN = 2'd3;
    reg [1:0] state;

    // radix-4 halves the number of stages (2 radix-2 stages -> 1 radix-4)
    wire [SWIDTH-1:0] last_stage = radix4 ? (STAGES/2 - 1) : (STAGES - 1);
    // GUESS: N/(2*P) butterfly groups per stage
    localparam [AWIDTH-1:0] LAST_STEP = (N/(2*P)) - 1;

    always @(posedge clk) begin
        if (!rst_n) begin
            state <= S_IDLE; busy <= 0; done <= 0; run <= 0;
            stage <= 0; step <= 0;
        end else begin
            done <= 1'b0;
            case (state)
                S_IDLE: begin
                    run <= 0; busy <= 0; stage <= 0; step <= 0;
                    if (start) begin state <= S_RUN; busy <= 1; run <= 1; end
                end
                S_RUN: begin
                    if (step == LAST_STEP) begin
                        step <= 0;
                        if (stage == last_stage) begin
                            run <= 0; state <= S_DRAIN;
                        end else stage <= stage + 1'b1;
                    end else step <= step + 1'b1;
                end
                S_DRAIN: begin
                    // GUESS: fixed pipeline-flush window before done
                    busy <= 0; done <= 1'b1; state <= S_IDLE;
                end
                default: state <= S_IDLE;
            endcase
        end
    end
endmodule

// ---------------------------------------------------------------------
// TOP: ties the blocks together. BRAM banks and the 8x4 crossbar are
// instantiated as behavioral memory + permutation; FIFOs are simple.
// ---------------------------------------------------------------------
module cfntt_top #(
    parameter integer N      = 1024,
    parameter integer WIDTH  = 14,
    parameter integer Q      = 12289,
    parameter integer BANKS  = 8,
    parameter integer P      = 4,        // parallel butterfly clusters
    parameter integer DEPTH  = N/BANKS,  // 128 words/bank
    parameter integer AWIDTH = 8,        // clog2(DEPTH) rounded
    parameter integer SWIDTH = 4,
    parameter integer TWIDTH = 9
) (
    input  wire                 clk,        // from clock_pll
    input  wire                 rst_n,
    input  wire                 start,
    input  wire                 radix4_cfg, // config_radix_selector
    input  wire                 intt_mode,  // forward (0) / inverse (1)
    // streaming input (input_fifo) / output (output_fifo)
    input  wire                 in_valid,
    input  wire [WIDTH-1:0]     in_data,
    output wire                 in_ready,
    output reg                  out_valid,
    output reg  [WIDTH-1:0]     out_data,
    output wire                 busy,
    output wire                 done
);
    // ---------- interleaved BRAM banks (single-port behavioral) ----------
    reg [WIDTH-1:0] bram [0:BANKS-1][0:DEPTH-1];

    // ---------- control ----------
    wire             run;
    wire [SWIDTH-1:0] stage;
    wire [AWIDTH-1:0] step;

    ntt_fsm #(.N(N), .P(P), .STAGES(10), .SWIDTH(SWIDTH), .AWIDTH(AWIDTH)) u_fsm (
        .clk(clk), .rst_n(rst_n), .start(start), .radix4(radix4_cfg),
        .busy(busy), .done(done), .run(run), .stage(stage), .step(step)
    );

    // ---------- address generation + crossbar selects ----------
    wire [P*3-1:0]      bsel_a, bsel_b;
    wire [P*AWIDTH-1:0] raddr;
    wire [TWIDTH-1:0]   tw_addr;

    addr_gen #(.N(N), .BANKS(BANKS), .P(P), .AWIDTH(AWIDTH),
               .SWIDTH(SWIDTH), .TWIDTH(TWIDTH)) u_ag (
        .clk(clk), .rst_n(rst_n), .run(run), .radix4(radix4_cfg),
        .stage(stage), .step(step),
        .bank_sel_a(bsel_a), .bank_sel_b(bsel_b),
        .rd_addr(raddr), .tw_addr(tw_addr)
    );

    // ---------- twiddle ROM (broadcast to all lanes) ----------
    wire [WIDTH-1:0] tw;
    twiddle_rom #(.WIDTH(WIDTH), .DEPTH(N/2), .AWIDTH(TWIDTH)) u_rom (
        .clk(clk), .addr(tw_addr), .w(tw)
    );

    // ---------- crossbar read (8x4) + P butterfly clusters ----------
    wire [WIDTH-1:0] bf_a_out [0:P-1];
    wire [WIDTH-1:0] bf_b_out [0:P-1];
    wire             bf_valid [0:P-1];

    genvar l;
    generate
        for (l = 0; l < P; l = l + 1) begin : g_bf
            wire [2:0]        ba = bsel_a[l*3 +: 3];
            wire [2:0]        bb = bsel_b[l*3 +: 3];
            wire [AWIDTH-1:0] ra = raddr[l*AWIDTH +: AWIDTH];
            wire [WIDTH-1:0]  a_op = bram[ba][ra];   // crossbar permute (read)
            wire [WIDTH-1:0]  b_op = bram[bb][ra];

            butterfly_unit #(.Q(Q), .WIDTH(WIDTH)) u_bf (
                .clk(clk), .rst_n(rst_n), .en(run),
                .a_in(a_op), .b_in(b_op), .w_in(tw),
                .a_out(bf_a_out[l]), .b_out(bf_b_out[l]),
                .valid(bf_valid[l])
            );

            // write-back through crossbar (1-cycle delayed select).
            reg [2:0]        ba_q, bb_q;
            reg [AWIDTH-1:0] ra_q;
            always @(posedge clk) begin ba_q<=ba; bb_q<=bb; ra_q<=ra; end
            always @(posedge clk) if (bf_valid[l]) begin
                bram[ba_q][ra_q] <= bf_a_out[l];
                bram[bb_q][ra_q] <= bf_b_out[l];
            end
        end
    endgenerate

    // ---------- input FIFO -> natural-order load into banks ----------
    reg [$clog2(N)-1:0] in_cnt;
    assign in_ready = !busy;
    always @(posedge clk) begin
        if (!rst_n) in_cnt <= 0;
        else if (in_valid && in_ready) begin
            // GUESS: bank = idx[2:0], addr = idx[9:3] (natural interleave)
            bram[in_cnt[2:0]][in_cnt[$clog2(N)-1:3]] <= in_data;
            in_cnt <= in_cnt + 1'b1;
        end
    end

    // ---------- output FIFO with optional INTT N^-1 scaling ----------
    reg [$clog2(N)-1:0] out_cnt;
    wire [WIDTH-1:0] raw_out = bram[out_cnt[2:0]][out_cnt[$clog2(N)-1:3]];
    wire [WIDTH-1:0] scaled_out;
    ninv_scale #(.Q(Q), .WIDTH(WIDTH)) u_ninv (.x(raw_out), .y(scaled_out));

    always @(posedge clk) begin
        if (!rst_n) begin out_cnt <= 0; out_valid <= 0; end
        else if (done) begin out_cnt <= 0; out_valid <= 1'b1; end
        else if (out_valid) begin
            out_data  <= intt_mode ? scaled_out : raw_out;
            out_cnt   <= out_cnt + 1'b1;
            if (out_cnt == N-1) out_valid <= 1'b0;
        end
    end
endmodule
