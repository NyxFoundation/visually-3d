// =====================================================================
// CFNTT: Scalable Radix-2/4 NTT Multiplication Accelerator (FPGA)
// Reverse-implemented from a scene-descriptor spec ONLY.
// Target: synthesizable Verilog-2001.
//
// Benchmark config from spec: N=1024 points, 14-bit modulus,
// up to 8 parallel butterfly units (4 clusters modeled in the scene).
// Reduction: Barrett (q-multiply then shift/subtract + correction).
// Radix-2 / radix-4 selectable. INTT shares the array (N^-1 scaling).
//
// NOTE: nearly every bit-width, port, opcode, FSM sequence and pipeline
// depth below is a GUESS (the spec is a 3D scene, not an RTL/datasheet).
// See the "guessed" / "underspecified" lists in the surrounding JSON.
// =====================================================================

// ---------------------------------------------------------------------
// Modular adder: (a + b) mod q, single conditional subtract.
// Assumes a,b already in [0,q).  Symmetric operator (shares with sub).
// ---------------------------------------------------------------------
module mod_add #(
    parameter W = 14
)(
    input  wire [W-1:0] a,
    input  wire [W-1:0] b,
    input  wire [W-1:0] q,
    output wire [W-1:0] s
);
    wire [W:0] sum = {1'b0,a} + {1'b0,b};
    wire [W:0] red = sum - {1'b0,q};
    // if sum >= q subtract q
    assign s = (sum >= {1'b0,q}) ? red[W-1:0] : sum[W-1:0];
endmodule

// ---------------------------------------------------------------------
// Modular subtractor: (a - b) mod q, single conditional add.
// ---------------------------------------------------------------------
module mod_sub #(
    parameter W = 14
)(
    input  wire [W-1:0] a,
    input  wire [W-1:0] b,
    input  wire [W-1:0] q,
    output wire [W-1:0] d
);
    wire [W:0] diff = {1'b0,a} - {1'b0,b};
    // diff[W] set => underflow => add q back
    assign d = diff[W] ? (diff[W-1:0] + q) : diff[W-1:0];
endmodule

// ---------------------------------------------------------------------
// Barrett modular reduction, split into the two scene "members":
//   member 1 (mod_red_mult)    : qhat = (x * mu) >> k   (quotient est.)
//   member 2 (mod_red_subshift): r = x - qhat*q, then <=2 corrections
// mu = floor(2^k / q),  k = 2*W (guessed).
// Input x is the product width (2*W). Output in [0,q).
// Implemented combinationally here; pipeline regs live in the butterfly.
// ---------------------------------------------------------------------
module barrett_qmul #(
    parameter W = 14,
    parameter K = 28          // 2*W
)(
    input  wire [2*W-1:0]   x,
    input  wire [K:0]       mu,   // floor(2^K / q), up to K+1 bits
    output wire [2*W-1:0]   qhat
);
    // full product x*mu is wide; keep enough MSBs then shift by K
    wire [2*W + K:0] prod = x * mu;
    assign qhat = prod >> K;
endmodule

module barrett_correct #(
    parameter W = 14
)(
    input  wire [2*W-1:0] x,
    input  wire [2*W-1:0] qhat,
    input  wire [W-1:0]   q,
    output wire [W-1:0]   r
);
    wire [2*W-1:0] qq  = qhat * q;
    wire [2*W-1:0] r0  = x - qq;          // r0 < 3q in the worst case
    wire [2*W-1:0] r1  = (r0 >= q) ? (r0 - q) : r0;
    wire [2*W-1:0] r2  = (r1 >= q) ? (r1 - q) : r1;  // 2nd correction
    assign r = r2[W-1:0];
endmodule

// ---------------------------------------------------------------------
// DSP-slice modular multiplier: (a * w) mod q via Barrett.
// Registered output (1 pipeline stage, guessed).
// ---------------------------------------------------------------------
module dsp_mod_mult #(
    parameter W = 14,
    parameter K = 28
)(
    input  wire             clk,
    input  wire             rst_n,
    input  wire [W-1:0]     a,
    input  wire [W-1:0]     w,
    input  wire [W-1:0]     q,
    input  wire [K:0]       mu,
    output reg  [W-1:0]     p
);
    wire [2*W-1:0] raw  = a * w;     // maps to DSP slice
    wire [2*W-1:0] qhat;
    wire [W-1:0]   r;
    barrett_qmul   #(.W(W),.K(K)) u_q (.x(raw), .mu(mu), .qhat(qhat));
    barrett_correct#(.W(W))       u_c (.x(raw), .qhat(qhat), .q(q), .r(r));
    always @(posedge clk or negedge rst_n)
        if (!rst_n) p <= {W{1'b0}};
        else        p <= r;
endmodule

// ---------------------------------------------------------------------
// One butterfly cluster (the scene's bu_base_x population):
//   DSP modular multiplier  -> symmetric mod add / mod sub -> pipe reg.
// Configurable radix-2 or radix-4 (radix-4 = two coupled radix-2 stages,
// here implemented as a 4-input DIT butterfly; GUESSED structure).
// ---------------------------------------------------------------------
module butterfly_cluster #(
    parameter W = 14,
    parameter K = 28
)(
    input  wire           clk,
    input  wire           rst_n,
    input  wire           radix4,      // 0: radix-2, 1: radix-4
    input  wire [W-1:0]   q,
    input  wire [K:0]     mu,
    // four operands (radix-2 uses only a0,a1)
    input  wire [W-1:0]   a0,
    input  wire [W-1:0]   a1,
    input  wire [W-1:0]   a2,
    input  wire [W-1:0]   a3,
    // twiddles (radix-2 uses only w1)
    input  wire [W-1:0]   w1,
    input  wire [W-1:0]   w2,
    input  wire [W-1:0]   w3,
    output reg  [W-1:0]   y0,
    output reg  [W-1:0]   y1,
    output reg  [W-1:0]   y2,
    output reg  [W-1:0]   y3
);
    // ---- multiply stage (registered) ----
    wire [W-1:0] m1, m2, m3;
    dsp_mod_mult #(.W(W),.K(K)) M1 (.clk(clk),.rst_n(rst_n),.a(a1),.w(w1),.q(q),.mu(mu),.p(m1));
    dsp_mod_mult #(.W(W),.K(K)) M2 (.clk(clk),.rst_n(rst_n),.a(a2),.w(w2),.q(q),.mu(mu),.p(m2));
    dsp_mod_mult #(.W(W),.K(K)) M3 (.clk(clk),.rst_n(rst_n),.a(a3),.w(w3),.q(q),.mu(mu),.p(m3));

    // a0 must be delayed one cycle to align with multiplier latency
    reg [W-1:0] a0_d, a2_d;
    reg         radix4_d;
    always @(posedge clk or negedge rst_n)
        if (!rst_n) begin a0_d<=0; a2_d<=0; radix4_d<=0; end
        else        begin a0_d<=a0; a2_d<=a2; radix4_d<=radix4; end

    // ---- radix-2 sum/diff on (a0_d, m1) ----
    wire [W-1:0] s_lo, d_lo;
    mod_add #(.W(W)) A_LO (.a(a0_d), .b(m1), .q(q), .s(s_lo));
    mod_sub #(.W(W)) S_LO (.a(a0_d), .b(m1), .q(q), .d(d_lo));

    // ---- radix-4 extra sum/diff on (a2_d', m3) for the second pair ----
    wire [W-1:0] s_hi, d_hi;
    mod_add #(.W(W)) A_HI (.a(m2), .b(m3), .q(q), .s(s_hi));
    mod_sub #(.W(W)) S_HI (.a(m2), .b(m3), .q(q), .d(d_hi));

    // ---- final radix-4 combine (GUESSED CT radix-4 mapping) ----
    wire [W-1:0] o0, o1, o2, o3;
    mod_add #(.W(W)) F0 (.a(s_lo), .b(s_hi), .q(q), .s(o0));
    mod_sub #(.W(W)) F2 (.a(s_lo), .b(s_hi), .q(q), .d(o2));
    mod_add #(.W(W)) F1 (.a(d_lo), .b(d_hi), .q(q), .s(o1));
    mod_sub #(.W(W)) F3 (.a(d_lo), .b(d_hi), .q(q), .d(o3));

    // ---- pipeline register (bu_reg) ----
    always @(posedge clk or negedge rst_n)
        if (!rst_n) begin y0<=0; y1<=0; y2<=0; y3<=0; end
        else if (radix4_d) begin
            y0<=o0; y1<=o1; y2<=o2; y3<=o3;
        end else begin
            y0<=s_lo; y1<=d_lo; y2<=0; y3<=0; // radix-2: two outputs
        end
endmodule

// ---------------------------------------------------------------------
// Twiddle-factor ROM: one fetch broadcast to all multipliers.
// Depth N (1024), width W. Initialized externally (.mem file, guessed).
// ---------------------------------------------------------------------
module twiddle_rom #(
    parameter W = 14,
    parameter N = 1024,
    parameter AW = 10
)(
    input  wire           clk,
    input  wire [AW-1:0]  addr,
    output reg  [W-1:0]   tw
);
    (* rom_style = "block" *) reg [W-1:0] rom [0:N-1];
    initial $readmemh("twiddle.hex", rom);   // GUESS: external init
    always @(posedge clk) tw <= rom[addr];
endmodule

// ---------------------------------------------------------------------
// Interleaved BRAM bank (one of 8). Simple dual-port, ~18Kb each.
// ---------------------------------------------------------------------
module bram_bank #(
    parameter W = 14,
    parameter DEPTH = 128,        // 1024/8 banks (guessed mapping)
    parameter AW = 7
)(
    input  wire          clk,
    input  wire          we,
    input  wire [AW-1:0] waddr,
    input  wire [W-1:0]  wdata,
    input  wire [AW-1:0] raddr,
    output reg  [W-1:0]  rdata
);
    (* ram_style = "block" *) reg [W-1:0] mem [0:DEPTH-1];
    always @(posedge clk) begin
        if (we) mem[waddr] <= wdata;
        rdata <= mem[raddr];
    end
endmodule

// ---------------------------------------------------------------------
// Inverse-NTT N^-1 scaling unit: multiply by N^-1 mod q (one mult).
// ---------------------------------------------------------------------
module intt_scale #(
    parameter W = 14,
    parameter K = 28
)(
    input  wire         clk,
    input  wire         rst_n,
    input  wire         intt_en,
    input  wire [W-1:0] x,
    input  wire [W-1:0] n_inv,
    input  wire [W-1:0] q,
    input  wire [K:0]   mu,
    output wire [W-1:0] y
);
    wire [W-1:0] scaled;
    dsp_mod_mult #(.W(W),.K(K)) MS (.clk(clk),.rst_n(rst_n),.a(x),.w(n_inv),.q(q),.mu(mu),.p(scaled));
    assign y = intt_en ? scaled : x;
endmodule

// ---------------------------------------------------------------------
// Address generation unit: produces conflict-free bank index + offset
// per cycle. The exact mapping function is NOT in the spec; modeled as
// a stage/index counter with an XOR-rotate bank permutation (GUESS).
// ---------------------------------------------------------------------
module addr_gen #(
    parameter LOGN = 10,
    parameter NBANK = 8,
    parameter LOGB = 3,
    parameter AW = 7
)(
    input  wire              clk,
    input  wire              rst_n,
    input  wire              en,
    input  wire [LOGN-1:0]   stage,     // current NTT stage
    output reg  [LOGB-1:0]   bank_idx,
    output reg  [AW-1:0]     offset,
    output reg               valid
);
    reg [LOGN-1:0] idx;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin idx<=0; bank_idx<=0; offset<=0; valid<=0; end
        else if (en) begin
            idx      <= idx + 1'b1;
            // conflict-free permutation (GUESSED): rotate by stage, xor
            bank_idx <= (idx[LOGB-1:0] ^ stage[LOGB-1:0]);
            offset   <= idx[LOGN-1:LOGB];
            valid    <= 1'b1;
        end else valid <= 1'b0;
    end
endmodule

// ---------------------------------------------------------------------
// Schedule / FSM controller: rearranged-loop sequencer.
// States: IDLE -> LOAD -> RUN(stage,group) -> SCALE(intt) -> DRAIN.
// Loop bounds: stages = log_r(N); the exact micro-schedule that yields
// the 33%/20% radix-4 savings is NOT in the spec (GUESSED skeleton).
// ---------------------------------------------------------------------
module schedule_fsm #(
    parameter LOGN = 10
)(
    input  wire           clk,
    input  wire           rst_n,
    input  wire           start,
    input  wire           radix4,
    input  wire           intt,
    input  wire           load_done,
    input  wire           stage_done,
    output reg            agu_en,
    output reg            bf_en,
    output reg            intt_en,
    output reg            drain_en,
    output reg [LOGN-1:0] stage,
    output reg            busy,
    output reg            done
);
    localparam IDLE=3'd0, LOAD=3'd1, RUN=3'd2, SCALE=3'd3, DRAIN=3'd4, FIN=3'd5;
    reg [2:0] st;
    // number of stages: radix-4 halves stage count vs radix-2 (guess)
    wire [LOGN-1:0] last_stage = radix4 ? (LOGN/2 - 1) : (LOGN - 1);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st<=IDLE; stage<=0;
            agu_en<=0; bf_en<=0; intt_en<=0; drain_en<=0; busy<=0; done<=0;
        end else begin
            done <= 1'b0;
            case (st)
                IDLE: begin
                    busy<=0; stage<=0;
                    agu_en<=0; bf_en<=0; intt_en<=0; drain_en<=0;
                    if (start) begin st<=LOAD; busy<=1; end
                end
                LOAD: if (load_done) begin st<=RUN; agu_en<=1; bf_en<=1; end
                RUN: begin
                    if (stage_done) begin
                        if (stage==last_stage) begin
                            bf_en<=0; agu_en<=0;
                            st <= intt ? SCALE : DRAIN;
                            intt_en <= intt;
                        end else stage <= stage + 1'b1;
                    end
                end
                SCALE: begin intt_en<=1; st<=DRAIN; end
                DRAIN: begin intt_en<=0; drain_en<=1; st<=FIN; end
                FIN:  begin drain_en<=0; done<=1; busy<=0; st<=IDLE; end
                default: st<=IDLE;
            endcase
        end
    end
endmodule

// ---------------------------------------------------------------------
// Top level: ties the scene together.
// Streaming AXI-ish FIFO ports are GUESSED (spec only names FIFOs).
// ---------------------------------------------------------------------
module cfntt_top #(
    parameter W      = 14,      // modulus width (spec: 14-bit)
    parameter K      = 28,      // Barrett shift = 2*W (guess)
    parameter N      = 1024,    // transform size (spec)
    parameter LOGN   = 10,
    parameter NBANK  = 8,       // spec: 8 interleaved banks
    parameter LOGB   = 3,
    parameter NCLUST = 4,       // spec models 4 clusters ("up to 8")
    parameter BAW    = 7        // per-bank addr width (1024/8 = 128)
)(
    input  wire             clk,
    input  wire             rst_n,
    // control / config
    input  wire             start,
    input  wire             radix4,        // config_radix_selector
    input  wire             intt,          // forward(0)/inverse(1)
    input  wire [W-1:0]     q,             // prime modulus
    input  wire [K:0]       mu,            // Barrett constant
    input  wire [W-1:0]     n_inv,         // N^-1 mod q
    output wire             busy,
    output wire             done,
    // input FIFO (forward-NTT coefficients in natural order)
    input  wire             in_valid,
    input  wire [W-1:0]     in_data,
    output wire             in_ready,
    // output FIFO (natural-order results)
    output wire             out_valid,
    output wire [W-1:0]     out_data,
    input  wire             out_ready
);
    // ---- PLL is external in real HW; here clk is assumed already locked ----

    // ---- controller ----
    wire           agu_en, bf_en, intt_en, drain_en;
    wire [LOGN-1:0] stage;
    // load/stage_done generation is GUESSED via simple counters below.
    reg  [LOGN-1:0] load_cnt;
    reg            load_done;
    reg  [LOGN-1:0] grp_cnt;
    reg            stage_done;

    schedule_fsm #(.LOGN(LOGN)) FSM (
        .clk(clk), .rst_n(rst_n), .start(start), .radix4(radix4),
        .intt(intt), .load_done(load_done), .stage_done(stage_done),
        .agu_en(agu_en), .bf_en(bf_en), .intt_en(intt_en),
        .drain_en(drain_en), .stage(stage), .busy(busy), .done(done));

    // load counter: assert load_done after N inputs accepted (guess)
    assign in_ready = !load_done;
    always @(posedge clk or negedge rst_n)
        if (!rst_n) begin load_cnt<=0; load_done<=0; end
        else if (start) begin load_cnt<=0; load_done<=0; end
        else if (in_valid && in_ready) begin
            load_cnt <= load_cnt + 1'b1;
            if (load_cnt == N-1) load_done <= 1'b1;
        end

    // groups-per-stage counter (guess): N/(NCLUST*radix) butterflies
    wire [LOGN-1:0] groups = radix4 ? (N/(NCLUST*4)) : (N/(NCLUST*2));
    always @(posedge clk or negedge rst_n)
        if (!rst_n) begin grp_cnt<=0; stage_done<=0; end
        else if (bf_en) begin
            if (grp_cnt == groups-1) begin grp_cnt<=0; stage_done<=1; end
            else begin grp_cnt<=grp_cnt+1'b1; stage_done<=0; end
        end else begin grp_cnt<=0; stage_done<=0; end

    // ---- address generation ----
    wire [LOGB-1:0] bank_idx;
    wire [BAW-1:0]  offset;
    wire            agu_valid;
    addr_gen #(.LOGN(LOGN),.NBANK(NBANK),.LOGB(LOGB),.AW(BAW)) AGU (
        .clk(clk), .rst_n(rst_n), .en(agu_en), .stage(stage),
        .bank_idx(bank_idx), .offset(offset), .valid(agu_valid));

    // ---- BRAM banks ----
    // Read/write wiring through the crossbar is data-path heavy; the exact
    // bank<->cluster permutation per cycle is GUESSED (see addr_gen).
    wire [W-1:0] bank_rdata [0:NBANK-1];
    reg  [W-1:0] bank_wdata [0:NBANK-1];
    reg          bank_we    [0:NBANK-1];
    reg  [BAW-1:0] bank_waddr[0:NBANK-1];
    reg  [BAW-1:0] bank_raddr[0:NBANK-1];
    genvar b;
    generate for (b=0; b<NBANK; b=b+1) begin: GBANK
        bram_bank #(.W(W),.DEPTH(N/NBANK),.AW(BAW)) BK (
            .clk(clk), .we(bank_we[b]), .waddr(bank_waddr[b]),
            .wdata(bank_wdata[b]), .raddr(bank_raddr[b]),
            .rdata(bank_rdata[b]));
    end endgenerate

    // ---- twiddle ROM (one fetch broadcast to all clusters) ----
    wire [W-1:0] tw;
    twiddle_rom #(.W(W),.N(N),.AW(LOGN)) TROM (
        .clk(clk), .addr(offset[0 +: LOGN > BAW ? BAW : LOGN] | {LOGN{1'b0}}), .tw(tw));

    // ---- crossbar: route bank reads to clusters (simplified mux) ----
    // GUESSED: cluster c reads bank (bank_idx + c) mod NBANK.
    wire [W-1:0] op0 [0:NCLUST-1];
    wire [W-1:0] op1 [0:NCLUST-1];
    wire [W-1:0] op2 [0:NCLUST-1];
    wire [W-1:0] op3 [0:NCLUST-1];
    genvar c;
    generate for (c=0; c<NCLUST; c=c+1) begin: GXBAR
        assign op0[c] = bank_rdata[(bank_idx + 4*c + 0) % NBANK];
        assign op1[c] = bank_rdata[(bank_idx + 4*c + 1) % NBANK];
        assign op2[c] = bank_rdata[(bank_idx + 4*c + 2) % NBANK];
        assign op3[c] = bank_rdata[(bank_idx + 4*c + 3) % NBANK];
    end endgenerate

    // ---- butterfly clusters ----
    wire [W-1:0] cy0 [0:NCLUST-1];
    wire [W-1:0] cy1 [0:NCLUST-1];
    wire [W-1:0] cy2 [0:NCLUST-1];
    wire [W-1:0] cy3 [0:NCLUST-1];
    generate for (c=0; c<NCLUST; c=c+1) begin: GCLUST
        butterfly_cluster #(.W(W),.K(K)) BU (
            .clk(clk), .rst_n(rst_n), .radix4(radix4), .q(q), .mu(mu),
            .a0(op0[c]), .a1(op1[c]), .a2(op2[c]), .a3(op3[c]),
            .w1(tw), .w2(tw), .w3(tw),     // GUESS: single broadcast twiddle
            .y0(cy0[c]), .y1(cy1[c]), .y2(cy2[c]), .y3(cy3[c]));
    end endgenerate

    // ---- shared modular reduction spine already inside dsp_mod_mult ----
    // (Barrett q-mul + shift/subtract reused per multiplier per spec.)

    // ---- write-back through crossbar to banks (GUESSED inverse perm) ----
    integer i;
    always @(*) begin
        for (i=0;i<NBANK;i=i+1) begin
            bank_we[i]    = bf_en;
            bank_waddr[i] = offset;
            bank_raddr[i] = offset;
            bank_wdata[i] = bank_rdata[i]; // default hold
        end
        // scatter cluster outputs back; mapping mirrors the read perm
        for (i=0;i<NCLUST;i=i+1) begin
            bank_wdata[(bank_idx + 4*i + 0) % NBANK] = cy0[i];
            bank_wdata[(bank_idx + 4*i + 1) % NBANK] = cy1[i];
            bank_wdata[(bank_idx + 4*i + 2) % NBANK] = cy2[i];
            bank_wdata[(bank_idx + 4*i + 3) % NBANK] = cy3[i];
        end
    end

    // ---- INTT N^-1 scaling on the drain path ----
    wire [W-1:0] drain_raw = bank_rdata[NBANK-1];      // tail bank
    wire [W-1:0] drain_scaled;
    intt_scale #(.W(W),.K(K)) ISC (
        .clk(clk), .rst_n(rst_n), .intt_en(intt_en),
        .x(drain_raw), .n_inv(n_inv), .q(q), .mu(mu), .y(drain_scaled));

    // ---- output FIFO interface (natural order, no bit-reversal) ----
    assign out_valid = drain_en;
    assign out_data  = drain_scaled;
    // out_ready backpressure handling is GUESSED (assumed always taken)

endmodule
