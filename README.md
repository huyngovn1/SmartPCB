> ⚠️ **IMPORTANT NOTICE – EXPERIMENTAL VERSION**
> SmartPCB 3.0 is currently an experimental beta version intended for testing, research, and learning purposes only. **It is not recommended for large-scale, complex, commercial, or production PCB projects.** The automation algorithms are still under development and may produce incomplete or incorrect results. Always review generated layouts, run DRC checks, and verify all electrical connections before use.
>
> # SmartPCB 3.0

**Experimental PCB Auto Placement & Routing for Altium Designer**

SmartPCB is an experimental PCB automation tool developed to assist electronic engineers with PCB component placement, automatic routing, layout optimization, and design analysis.

The project uses Altium Designer's scripting environment to process PCB designs and generate detailed reports for evaluating placement and routing results.

**Version:** 3.0 Beta  
**Platform:** Windows 10 / 11 (64-bit)  
**Altium Versions:** 2016 / 2021 / 2024 (Experimental Testing)  
**Status:** Under Development

> **Beta Release:** SmartPCB is currently a testing project. Automatic placement and routing are not fully optimized. Results depend on PCB complexity, design constraints, and available routing space.

---

## 1. Features

| Feature | Description |
|---|---|
| Auto Placement | Analyzes component locations and attempts placement optimization |
| Auto Routing | Automatically generates PCB traces between connected pads |
| Routing Only | Runs the routing engine without requesting placement optimization |
| Design Analysis | Evaluates layout geometry, connection paths, and placement constraints |
| Layer Support | Supports routing analysis across configured signal layers |
| Via Generation | Adds vias when routing between supported layers |
| Rule Analysis | Reads PCB rules and analyzes relevant design constraints |
| Placement Protection | Preserves locked component positions |
| Routing Reports | Lists completed and unresolved connections |
| Visual Comparison | Displays PCB layouts before and after processing |
| Performance Metrics | Reports iterations, wirelength, congestion, and routing statistics |

---

## 2. System Requirements

The following specifications are suggested for experimental use. They are not measured minimum hardware requirements.

| Component | Suggested Minimum | Recommended |
|---|---|---|
| Operating System | Windows 10 64-bit | Windows 10 / 11 64-bit |
| Processor | Intel Core i5 or equivalent | Intel Core i5 / i7, 6 cores or higher |
| RAM | 8 GB | 16–32 GB |
| Storage | 1 GB free space for the tool and working files | SSD with additional space for PCB projects |
| Graphics | Integrated graphics | Integrated or dedicated GPU |
| Display | 1920 × 1080 | Full HD or higher |
| Software | Altium Designer | Altium Designer 2016 / 2021 / 2024 |

**Hardware Notes**

- 8 GB RAM is a suggested starting point for small projects.
- 16 GB RAM is recommended for development and general PCB design.
- 32 GB RAM may be beneficial for complex multilayer PCB projects.
- A dedicated GPU is not required specifically for SmartPCB automation.
- Large designs may consume significant CPU resources and memory during routing searches.
- Performance depends on PCB size, number of connections, routing rules, and search limits.

---

## 3. Altium Designer Integration

SmartPCB is executed through the Altium Designer scripting environment.

<img width="520" height="456" alt="SmartPCB script procedures in Altium Designer" src="https://github.com/user-attachments/assets/5823a91b-b178-4b6b-ad41-d8373b13696e" />

### Available Procedures

| Procedure | Function |
|---|---|
| `PreviewSmart` | Generates or opens the PCB analysis preview |
| `SmartAuto` | Runs the automatic placement and routing workflow |
| `SmartRouteOnly` | Executes routing without requesting placement optimization |
| `SP_FindEngine` | Locates the automation engine |
| `SP_Init` | Initializes the SmartPCB environment |
| `SP_ReadRules` | Reads PCB design rules |
| `SP_ReadTables` | Loads routing-related information |
| `SP_ResolveBoard` | Resolves the active PCB document |
| `SP_RunEngine` | Executes the automation engine |
| `SP_Free` | Releases engine resources |

### Basic Usage

1. Open Altium Designer.
2. Open the PCB project you want to process.
3. Back up the original `.PcbDoc` file.
4. Load the SmartPCB script project (`.PrjScr`).
5. Open the script execution dialog.
6. Select `SmartAuto` for automatic processing or `SmartRouteOnly` for routing.
7. Wait for the automation process to finish.
8. Review the generated preview and analysis reports.
9. Check the result using Altium Designer DRC before further use.

**Important:** Test with a copy of the original PCB document to avoid unwanted design changes.

---

## 4. Automatic PCB Processing

SmartPCB analyzes existing PCB geometry, component restrictions, available signal layers, and electrical connections before generating an automated layout proposal.

### Before & After Analysis

<img width="1437" height="925" alt="SmartPCB automatic placement and routing before and after comparison" src="https://github.com/user-attachments/assets/53ad8099-14a0-406e-a878-7636e97c83af" />

The comparison interface displays the initial PCB layout alongside the automatically generated result.

### Example Test Results

| Parameter | Result |
|---|---|
| Components analyzed | 167 |
| Components moved | 1 |
| Routed connection pairs | 21 / 339 |
| Additional vias | 22 |
| New routing length | 285.82 mm |
| Existing fixed-placement violations | 101 |
| Remaining connection pairs | 318 |

The placement process preserves locked components and reports existing spacing problems rather than moving protected objects.

**These numbers represent one example test board and do not describe the performance of every PCB design.**

---

## 5. Unresolved Connections

<img width="1366" height="929" alt="SmartPCB unresolved PCB connection report" src="https://github.com/user-attachments/assets/c6abe8d6-d69e-498e-812b-05381a9db27e" />

SmartPCB records connections that cannot be completed within the current routing search limits.

The report identifies each unresolved connection using its net name, source pad, destination pad, and failure description.

### Possible Routing Limitations

- Insufficient routing space
- Dense component placement
- Restricted routing paths
- Search expansion limits
- PCB obstacles and clearance constraints
- Unresolved multilayer routing requirements

Connections that cannot be completed remain available for manual routing or further optimization.

This report is especially useful when testing dense PCB designs with large numbers of connected pads.

---

## 6. Placement Optimization Metrics

<img width="1214" height="910" alt="SmartPCB automatic placement optimization statistics" src="https://github.com/user-attachments/assets/4cdb7cf7-58ad-4291-b249-945a46bc8be1" />

The placement analysis provides numerical information about the optimization process.

### Available Statistics

| Metric | Description |
|---|---|
| Component Count | Total components analyzed |
| Movable Count | Number of components allowed to move |
| Locked Count | Components with protected positions |
| Moved Count | Components actually repositioned |
| Wirelength Before / After | Estimated total connection length |
| Congestion Before / After | Estimated routing congestion |
| Iterations | Optimization search iterations |
| Feasible Trials | Valid placement candidates evaluated |
| Accepted Trials | Placement candidates accepted |
| Existing Violations | Previously existing spacing or position conflicts |

The engine uses geometric calculations and placement constraints to evaluate candidate positions.

Fixed components remain in their original locations unless the design configuration permits movement.

---

## 7. Automatic Routing Metrics

<img width="1021" height="943" alt="SmartPCB automatic PCB routing engine statistics" src="https://github.com/user-attachments/assets/4d600618-66da-42b3-a7b9-81e85004119f" />

The routing report displays information about the search process, successfully routed connections, and routing workload.

### Routing Information

- Total connection pairs
- Successfully routed pairs
- Routing pass count
- Search expansions
- Connection processing order
- Unresolved routing operations

### Current Routing Behavior

The engine attempts to find valid geometric paths between PCB pads using the available routing configuration.

Routing results are affected by available layers, obstacles, clearance requirements, and search limits.

For dense multilayer boards, some connections may remain incomplete and require manual intervention.

---

## 8. Compatibility Testing

SmartPCB is being evaluated across different versions of Altium Designer.

| Version | Status |
|---|---|
| Altium Designer 2016 | Experimental |
| Altium Designer 2021 | Experimental |
| Altium Designer 2024 | Experimental |

Compatibility testing remains ongoing. Full functionality and identical results across these versions are not guaranteed.

Differences in scripting APIs, PCB document structures, and design-rule handling may affect operation.

---

## 9. Current Limitations

SmartPCB 3.0 is not yet intended to replace professional PCB design and verification workflows.

Current limitations include:

- Automatic routing may leave connections incomplete.
- Component optimization is constrained by locked positions and existing geometry.
- Dense boards can require substantial routing search resources.
- Some design constraints may need additional implementation or verification.
- Routing results are not guaranteed to meet all electrical and manufacturing requirements.
- Generated layouts require manual inspection and DRC verification.
- Performance and stability testing are still ongoing.

**The tool does not guarantee a fully connected, manufacturing-ready PCB.**

---

## 10. Development Roadmap

- [x] Altium scripting integration
- [x] PCB document analysis
- [x] Basic automatic component placement
- [x] Experimental automatic routing
- [x] Routing and placement metrics
- [x] Before / After PCB visualization
- [x] Unresolved connection reporting
- [ ] Improve routing completion on dense PCBs
- [ ] Improve multilayer routing algorithms
- [ ] Enhance design-rule awareness
- [ ] Improve placement optimization
- [ ] Reduce routing computation time
- [ ] Expand testing across Altium versions
- [ ] Improve overall reliability and stability

---

## 11. Feedback & Contributions

SmartPCB is an experimental development project, and feedback from PCB designers and Altium users is welcome.

If you encounter bugs, unexpected behavior, or compatibility problems, please open a GitHub Issue with:

- Altium Designer version
- Windows version
- System RAM and CPU information
- PCB layer count and approximate complexity
- Error messages or screenshots
- Steps required to reproduce the problem

Test reports and optimization suggestions are appreciated.

---

## 12. Disclaimer

SmartPCB is an independent project and is not affiliated with, sponsored by, or officially supported by Altium Limited.

This software is provided for experimentation, educational use, and PCB automation research.

Users are responsible for reviewing all generated PCB modifications, verifying electrical connectivity, and performing appropriate design-rule and manufacturing checks.

---

**SmartPCB 3.0 | Experimental PCB Automation Project**

*Automate. Analyze. Optimize.*
