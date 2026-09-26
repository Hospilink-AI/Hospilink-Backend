const INDIAN_STATES = [
    // 28 States (alphabetical)
    'Andhra Pradesh',
    'Arunachal Pradesh',
    'Assam',
    'Bihar',
    'Chhattisgarh',
    'Goa',
    'Gujarat',
    'Haryana',
    'Himachal Pradesh',
    'Jharkhand',
    'Karnataka',
    'Kerala',
    'Madhya Pradesh',
    'Maharashtra',
    'Manipur',
    'Meghalaya',
    'Mizoram',
    'Nagaland',
    'Odisha',
    'Punjab',
    'Rajasthan',
    'Sikkim',
    'Tamil Nadu',
    'Telangana',
    'Tripura',
    'Uttar Pradesh',
    'Uttarakhand',
    'West Bengal',

    // 8 Union Territories (alphabetical)
    'Andaman and Nicobar Islands',
    'Chandigarh',
    'Dadra and Nagar Haveli and Daman and Diu',
    'Delhi',
    'Jammu and Kashmir',
    'Ladakh',
    'Lakshadweep',
    'Puducherry',
];



const ALLOWED_ROLES = [
    'rmo', 'dmo', 'general_physician', 'intensivist', 'emergency_doctor',
    'anesthetist', 'pediatrician', 'gynecologist', 'orthopedic_surgeon',
    'general_surgeon', 'radiologist', 'pathologist', 'staff_nurse',
    'icu_nurse', 'emergency_nurse', 'ot_nurse', 'dialysis_nurse', 'nicu_nurse',
    'lab_technician', 'radiology_technician', 'ot_technician', 'dialysis_technician',
    'cath_lab_technician', 'icu_technician', 'ward_boy', 'ayah', 'opd_attendant',
    'emergency_attendant', 'patient_care_taker', 'pharmacist', 'pharmacy_assistant',
    'biomedical_engineer', 'housekeeping_staff', 'security_guard', 'ambulance_driver',
    'receptionist', 'billing_executive', 'medical_records_staff', 'hr_accounts'
];



const SPECIALTY_FAMILIES = {
    rmo: 'Doctor', dmo: 'Doctor', general_physician: 'Doctor', intensivist: 'Doctor',
    emergency_doctor: 'Doctor', anesthetist: 'Doctor', pediatrician: 'Doctor', gynecologist: 'Doctor',
    orthopedic_surgeon: 'Surgeon', general_surgeon: 'Surgeon',
    radiologist: 'Diagnostics', pathologist: 'Diagnostics',
    staff_nurse: 'Nursing', icu_nurse: 'Nursing', emergency_nurse: 'Nursing',
    ot_nurse: 'Nursing', dialysis_nurse: 'Nursing', nicu_nurse: 'Nursing',
    lab_technician: 'Technician', radiology_technician: 'Technician', ot_technician: 'Technician',
    dialysis_technician: 'Technician', cath_lab_technician: 'Technician', icu_technician: 'Technician',
    biomedical_engineer: 'Technician',
    ward_boy: 'Patient Support', ayah: 'Patient Support', opd_attendant: 'Patient Support',
    emergency_attendant: 'Patient Support', patient_care_taker: 'Patient Support',
    pharmacist: 'Pharmacy', pharmacy_assistant: 'Pharmacy',
    housekeeping_staff: 'Administrative & Support', security_guard: 'Administrative & Support',
    ambulance_driver: 'Administrative & Support', receptionist: 'Administrative & Support',
    billing_executive: 'Administrative & Support', medical_records_staff: 'Administrative & Support',
    hr_accounts: 'Administrative & Support'
};



module.exports = {
    INDIAN_STATES,
    ALLOWED_ROLES,
    SPECIALTY_FAMILIES
};
